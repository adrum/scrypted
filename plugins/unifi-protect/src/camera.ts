import sdk, { ScryptedDeviceBase, DeviceProvider, Settings, Setting, VideoCamera, MediaObject, MotionSensor, ScryptedInterface, Camera, MediaStreamOptions, Intercom, ScryptedMimeTypes, FFMpegInput, ObjectDetector, PictureOptions, ObjectDetectionTypes, ObjectsDetected, Notifier, SCRYPTED_MEDIA_SCHEME, VideoCameraConfiguration, OnOff } from "@scrypted/sdk";
import { ProtectCameraChannelConfig, ProtectCameraConfig, ProtectCameraConfigInterface, ProtectCameraLcdMessagePayload } from "@koush/unifi-protect";
import child_process, { ChildProcess } from 'child_process';
import { ffmpegLogInitialOutput } from '../../../common/src/media-helpers';
import { fitHeightToWidth } from "../../../common/src/resolution-utils";
import { listenZero } from "../../../common/src/listen-cluster";
import net from 'net';
import WS from 'ws';
import { once } from "events";
import { FeatureFlagsShim } from "./shim";
import { UnifiProtect } from "./main";

const { log, deviceManager, mediaManager } = sdk;

export const defaultSensorTimeout = 30;

export class UnifiPackageCamera extends ScryptedDeviceBase implements Camera, VideoCamera, MotionSensor {
    constructor(public camera: UnifiCamera, nativeId: string) {
        super(nativeId);
    }
    async takePicture(options?: PictureOptions): Promise<MediaObject> {
        const buffer = await this.camera.getSnapshot(options, 'package-snapshot?');
        return mediaManager.createMediaObject(buffer, 'image/jpeg');
    }
    async getPictureOptions(): Promise<PictureOptions[]> {
        return;
    }
    async getVideoStream(options?: MediaStreamOptions): Promise<MediaObject> {
        const o = (await this.getVideoStreamOptions())[0];
        return this.camera.getVideoStream(o);
    }
    async getVideoStreamOptions(): Promise<MediaStreamOptions[]> {
        const options = await this.camera.getVideoStreamOptions();
        return [options[options.length - 1]];
    }
}

export class UnifiCamera extends ScryptedDeviceBase implements Notifier, Intercom, Camera, VideoCamera, VideoCameraConfiguration, MotionSensor, Settings, ObjectDetector, DeviceProvider, OnOff {
    motionTimeout: NodeJS.Timeout;
    detectionTimeout: NodeJS.Timeout;
    ringTimeout: NodeJS.Timeout;
    lastMotion: number;
    lastRing: number;
    lastSeen: number;
    intercomProcess?: ChildProcess;
    packageCamera?: UnifiPackageCamera;

    constructor(public protect: UnifiProtect, nativeId: string, protectCamera: Readonly<ProtectCameraConfigInterface>) {
        super(nativeId);
        this.lastMotion = protectCamera?.lastMotion;
        this.lastRing = protectCamera?.lastRing;
        this.lastSeen = protectCamera?.lastSeen;

        if (this.interfaces.includes(ScryptedInterface.BinarySensor)) {
            this.binaryState = false;
        }

        this.updateState(protectCamera);
    }

    async setStatusLight(on: boolean) {
        const camera = this.findCamera() as any;
        await this.protect.api.updateCamera(camera, {
            ledSettings: {
                isEnabled: on,
            }
        });
    }

    async turnOn(): Promise<void> {
        this.setStatusLight(true);
    }

    async turnOff(): Promise<void> {
        this.setStatusLight(false);
    }

    get packageCameraNativeId() {
        return this.nativeId + '-packageCamera';
   }

    ensurePackageCamera() {
        if (!this.packageCamera) {
            this.packageCamera = new UnifiPackageCamera(this, this.packageCameraNativeId);
        }
    }
    async getDevice(nativeId: string) {
        this.ensurePackageCamera();
        return this.packageCamera;
    }

    async startIntercom(media: MediaObject) {
        const buffer = await mediaManager.convertMediaObjectToBuffer(media, ScryptedMimeTypes.FFmpegInput);
        const ffmpegInput = JSON.parse(buffer.toString()) as FFMpegInput;

        const camera = this.findCamera();
        const params = new URLSearchParams({ camera: camera.id });
        const response = await this.protect.loginFetch(this.protect.api.wsUrl() + "/talkback?" + params.toString());
        const tb = await response.json() as Record<string, string>;

        // Adjust the URL for our address.
        const tbUrl = new URL(tb.url);
        tbUrl.hostname = this.protect.getSetting('ip');
        const talkbackUrl = tbUrl.toString();

        const websocket = new WS(talkbackUrl, { rejectUnauthorized: false });
        await once(websocket, 'open');

        const server = new net.Server(async (socket) => {
            server.close();

            this.console.log('sending audio data to', talkbackUrl);

            try {
                while (websocket.readyState === WS.OPEN) {
                    await once(socket, 'readable');
                    while (true) {
                        const data = socket.read();
                        if (!data)
                            break;
                        websocket.send(data, e => {
                            if (e)
                                socket.destroy();
                        });
                    }
                }
            }
            finally {
                this.console.log('talkback ended')
                this.intercomProcess.kill();
            }
        });
        const port = await listenZero(server)

        const args = ffmpegInput.inputArguments.slice();

        args.push(
            "-acodec", "libfdk_aac",
            "-profile:a", "aac_low",
            "-threads", "0",
            "-avioflags", "direct",
            "-max_delay", "3000000",
            "-flush_packets", "1",
            "-flags", "+global_header",
            "-ar", camera.talkbackSettings.samplingRate.toString(),
            "-ac", camera.talkbackSettings.channels.toString(),
            "-b:a", "16k",
            "-f", "adts",
            `tcp://127.0.0.1:${port}`,
        );

        this.console.log('starting 2 way audio', args);

        const ffmpeg = await mediaManager.getFFmpegPath();
        this.intercomProcess = child_process.spawn(ffmpeg, args);
        this.intercomProcess.on('exit', () => {
            websocket.close();
            this.intercomProcess = undefined;
        });
        ffmpegLogInitialOutput(this.console, this.intercomProcess);
    }

    async stopIntercom() {
        this.intercomProcess?.kill();
        this.intercomProcess = undefined;
    }
    async getObjectTypes(): Promise<ObjectDetectionTypes> {
        const classes = ['motion'];
        if (this.interfaces.includes(ScryptedInterface.BinarySensor))
            classes.push('ring');
        if (this.interfaces.includes(ScryptedInterface.ObjectDetector))
            classes.push(...this.findCamera().featureFlags.smartDetectTypes);
        return {
            classes,
        };
    }

    async getDetectionInput(detectionId: any): Promise<MediaObject> {
        const input = this.protect.runningEvents.get(detectionId);
        if (input) {
            this.console.log('fetching event snapshot', detectionId);
            await input.promise;
        }
        const url = `https://${this.protect.getSetting('ip')}/proxy/protect/api/events/${detectionId}/thumbnail`;
        const response = await this.protect.api.fetch(url);
        if (!response) {
            throw new Error('Unifi Protect login refresh failed.');
        }
        const data = await response.arrayBuffer();
        return mediaManager.createMediaObject(Buffer.from(data), 'image/jpeg');
    }

    getDefaultOrderedVideoStreamOptions(vsos: MediaStreamOptions[]) {
        if (!vsos || !vsos.length)
            return vsos;
        const defaultStream = this.getDefaultStream(vsos);
        if (!defaultStream)
            return vsos;
        vsos = vsos.filter(vso => vso.id !== defaultStream?.id);
        vsos.unshift(defaultStream);
        return vsos;
    }

    getDefaultStream(vsos: MediaStreamOptions[]) {
        let defaultStreamIndex = vsos.findIndex(vso => vso.id === this.storage.getItem('defaultStream'));
        if (defaultStreamIndex === -1)
            defaultStreamIndex = 0;

        return vsos[defaultStreamIndex];
    }

    async getSettings(): Promise<Setting[]> {
        const vsos = await this.getVideoStreamOptions();
        const defaultStream = this.getDefaultStream(vsos);
        return [
            {
                title: 'Default Stream',
                key: 'defaultStream',
                value: defaultStream?.name,
                choices: vsos.map(vso => vso.name),
                description: 'The default stream to use when not specified',
            },
            {
                title: 'Sensor Timeout',
                key: 'sensorTimeout',
                value: this.storage.getItem('sensorTimeout') || defaultSensorTimeout,
                description: 'Time to wait in seconds before clearing the motion, doorbell button, or object detection state.',
            }
        ];
    }

    async putSetting(key: string, value: string | number | boolean) {
        if (key === 'defaultStream') {
            const vsos = await this.getVideoStreamOptions();
            const stream = vsos.find(vso => vso.name === value);
            this.storage.setItem('defaultStream', stream?.id);
        }
        else {
            this.storage.setItem(key, value?.toString());
        }
        this.onDeviceEvent(ScryptedInterface.Settings, undefined);
    }

    getSensorTimeout() {
        return (parseInt(this.storage.getItem('sensorTimeout')) || 10) * 1000;
    }

    resetMotionTimeout() {
        clearTimeout(this.motionTimeout);
        this.motionTimeout = setTimeout(() => {
            this.setMotionDetected(false);
        }, this.getSensorTimeout());
    }

    resetDetectionTimeout() {
        clearTimeout(this.detectionTimeout);
        this.detectionTimeout = setTimeout(() => {
            const detect: ObjectsDetected = {
                timestamp: Date.now(),
                detections: []
            }
            this.onDeviceEvent(ScryptedInterface.ObjectDetector, detect);
        }, this.getSensorTimeout());
    }

    resetRingTimeout() {
        clearTimeout(this.ringTimeout);
        this.ringTimeout = setTimeout(() => {
            this.binaryState = false;
        }, this.getSensorTimeout());
    }

    async getSnapshot(options?: PictureOptions, suffix?: string): Promise<Buffer> {
        suffix = suffix || 'snapshot';
        let size = '';
        try {
            if (options?.picture?.width && options?.picture?.height) {
                const camera = this.findCamera();
                const mainChannel = camera.channels[0];
                const w = options.picture.width;
                const h = fitHeightToWidth(mainChannel.width, mainChannel.height, w);

                size = `&w=${w}&h=${h}`;
            }
        }
        catch (e) {

        }
        const url = `https://${this.protect.getSetting('ip')}/proxy/protect/api/cameras/${this.nativeId}/${suffix}?ts=${Date.now()}${size}`

        const response = await this.protect.loginFetch(url);
        if (!response) {
            throw new Error('Unifi Protect login refresh failed.');
        }
        const data = await response.arrayBuffer();
        return Buffer.from(data);
    }

    async takePicture(options?: PictureOptions): Promise<MediaObject> {
        const buffer = await this.getSnapshot(options);
        return mediaManager.createMediaObject(buffer, 'image/jpeg');
    }
    findCamera() {
        return this.protect.api.cameras.find(camera => camera.id === this.nativeId);
    }
    async getVideoStream(options?: MediaStreamOptions): Promise<MediaObject> {
        const camera = this.findCamera();
        const vsos = await this.getVideoStreamOptions();
        const vso = vsos.find(check => check.id === options?.id) || this.getDefaultStream(vsos);

        const rtspChannel = camera.channels.find(check => check.id === vso.id);

        const { rtspAlias } = rtspChannel;
        const u = `rtsp://${this.protect.getSetting('ip')}:7447/${rtspAlias}`

        return mediaManager.createFFmpegMediaObject({
            url: u,
            inputArguments: [
                "-rtsp_transport",
                "tcp",
                '-analyzeduration', '15000000',
                '-probesize', '100000000',
                "-reorder_queue_size",
                "1024",
                "-max_delay",
                "20000000",
                "-i",
                u,
            ],
            mediaStreamOptions: this.createMediaStreamOptions(rtspChannel),
        });
    }

    createMediaStreamOptions(channel: ProtectCameraChannelConfig) {
        const ret: MediaStreamOptions = {
            id: channel.id,
            name: channel.name,
            video: {
                codec: 'h264',
                width: channel.width,
                height: channel.height,
                bitrate: channel.maxBitrate,
                minBitrate: channel.minBitrate,
                maxBitrate: channel.maxBitrate,
                fps: channel.fps,
                idrIntervalMillis: channel.idrInterval * 1000,
            },
            audio: {
                codec: 'aac',
            },
        };
        return ret;
    }

    async getVideoStreamOptions(): Promise<MediaStreamOptions[]> {
        const camera = this.findCamera();
        const video: MediaStreamOptions[] = camera.channels
            .map(channel => this.createMediaStreamOptions(channel));

        return this.getDefaultOrderedVideoStreamOptions(video);
    }

    async setVideoStreamOptions(options: MediaStreamOptions): Promise<void> {
        const bitrate = options?.video?.bitrate;
        if (!bitrate)
            return;

        const camera = this.findCamera();
        const channel = camera.channels.find(channel => channel.id === options.id);

        const sanitizedBitrate = Math.min(channel.maxBitrate, Math.max(channel.minBitrate, bitrate));
        this.console.log('bitrate change requested', bitrate, 'clamped to', sanitizedBitrate);
        channel.bitrate = sanitizedBitrate;
        const cameraResult = await this.protect.api.updateCameraChannels(camera);
        if (!cameraResult) {
            throw new Error("setVideoStreamOptions failed")
        }
    }

    async getPictureOptions(): Promise<PictureOptions[]> {
        return;
    }

    setMotionDetected(motionDetected: boolean) {
        this.motionDetected = motionDetected;
        if ((this.findCamera().featureFlags as any as FeatureFlagsShim).hasPackageCamera) {
            if (deviceManager.getNativeIds().includes(this.packageCameraNativeId)) {
                this.ensurePackageCamera();
                this.packageCamera.motionDetected = motionDetected;
            }
        }
    }

    async sendNotification(title: string, body: string, media: string | MediaObject, mimeType?: string): Promise<void> {
        const payload: ProtectCameraLcdMessagePayload = {
            text: body.substring(0, 30),
            type: 'CUSTOM_MESSAGE',
        };
        this.protect.api.updateCamera(this.findCamera(), {
            lcdMessage: payload,
        })

        if (typeof media === 'string' && media.startsWith(SCRYPTED_MEDIA_SCHEME)) {
            media = await mediaManager.createMediaObjectFromUrl(media);
        }
        if (media) {
            if (typeof media === 'string') {
                media = await mediaManager.createMediaObjectFromUrl(media);
            }
            this.startIntercom(media);
        }
    }

    updateState(camera?: Readonly<ProtectCameraConfigInterface>) {
        camera = camera || this.findCamera();
        if (!camera)
            return;
        this.on = !!camera.ledSettings?.isEnabled;
        this.setMotionDetected(!!camera.isMotionDetected);
    }
}
