<template>
  <v-card style="height: 400px">
    <v-card-title>{{ label }}</v-card-title>
    <apexchart
      type="donut"
      height="300"
      width="100%"
      :options="chartOptions"
      :series="series"
    ></apexchart>
  </v-card>
</template>

<script>
export default {
  props: ["labels", "series", "label"],
  computed: {
    chartOptions() {
      const self = this;
      return {
        chart: {
          events: {
            dataPointSelection(e, t, dataPoint) {
              self.$emit('dataPointSelection', dataPoint);
            },
          },
          type: "donut",
          animations: {
            speed: 400,
          },
          background: "transparent",
        },
        stroke: {
          show: true,
          colors: [this.$vuetify.theme.isDark ? "#333" : "#fff"],
          width: 1,
          dashArray: 0,
        },
        plotOptions: {
          pie: {
            expandOnClick: false,
            donut: {
              size: "74%",
            },
          },
        },

        labels: this.labels.map(label => label.replace(' Plugin', '').replace(' Controller', '')),
        dataLabels: {
          enabled: false,
        },
        legend: {
          show: this.$vuetify.breakpoint.smAndUp,
          offsetY: 0,
          fontSize: "13px",
          fontFamily: "Quicksand",
          fontWeight: 700,
          width: 200,
        },
        ...this.options,
      };
    },
  },
};
</script>
