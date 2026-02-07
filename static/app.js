const metricSelect = document.getElementById("metric");
const startInput = document.getElementById("start");
const endInput = document.getElementById("end");
const loadButton = document.getElementById("load");

const chart = echarts.init(document.getElementById("chart"));
const themeVars = getComputedStyle(document.documentElement);
const chartLineColor = themeVars.getPropertyValue("--chart-line").trim();
const chartAreaColor = themeVars.getPropertyValue("--chart-area").trim();
const dateOptions = {
  enableTime: true,
  time_24hr: true,
  dateFormat: "Y-m-d H:i",
  allowInput: true,
};
const startPicker = flatpickr(startInput, dateOptions);
const endPicker = flatpickr(endInput, dateOptions);
const quickButtons = document.querySelectorAll(".quick-range-btn");

function setQueryParam(key, value) {
  const url = new URL(window.location.href);
  if (value) {
    url.searchParams.set(key, value);
  } else {
    url.searchParams.delete(key);
  }
  window.history.replaceState({}, "", url);
}

function getQueryParam(key) {
  return new URLSearchParams(window.location.search).get(key);
}

function applyQuickRange(hours) {
  const now = new Date();
  const start = new Date(now.getTime() - hours * 60 * 60 * 1000);
  startPicker.setDate(start, true);
  endPicker.setDate(now, true);
  handleMetricChange().catch((err) => {
    console.error(err);
  });
}

async function fetchMetrics() {
  const res = await fetch("api/metrics");
  const data = await res.json();
  metricSelect.innerHTML = "";

  for (const item of data) {
    const opt = document.createElement("option");
    opt.value = item.metric_id;
    const label = item.name || item.metric_id;
    if (item.unit) {
      opt.textContent = `${label} (${item.unit})`;
    } else {
      opt.textContent = label;
    }
    metricSelect.appendChild(opt);
  }
}

async function fetchSeries() {
  const params = new URLSearchParams({
    metric_id: metricSelect.value,
    value: "state",
  });
  const startDate = startPicker.selectedDates[0] || new Date(startInput.value);
  const endDate = endPicker.selectedDates[0] || new Date(endInput.value);
  if (!Number.isNaN(startDate.getTime())) params.set("start", startDate.toISOString());
  if (!Number.isNaN(endDate.getTime())) params.set("end", endDate.toISOString());

  const res = await fetch(`api/timeseries?${params.toString()}`);
  const data = await res.json();

  const labels = data.labels || [];
  const points = data.points || [];

  const chartOptions = { ...data.chart_options } || {};
  const chartType = chartOptions.type || "line";
  const seriesSmooth = chartOptions.smooth || false;
  delete chartOptions.type;
  delete chartOptions.smooth;

  const seriesData = labels.map((label, index) => {
    const value = points[index];
    if (value == null) {
      return [label, null];
    }
    return [label, Math.round(value * 100) / 100];
  });

  chart.setOption({
    grid: { left: 16, right: 16, top: 16, bottom: 16, containLabel: true },
    tooltip: {
      trigger: "axis",
      valueFormatter: (value) =>
        value == null ? "" : (Math.round(Number(value) * 100) / 100).toFixed(2),
    },
    xAxis: {
      type: "time",
      axisLabel: {
        formatter: (value) => {
          const date = new Date(value);
          if (Number.isNaN(date.getTime())) {
            return value;
          }
          const hours = String(date.getUTCHours()).padStart(2, "0");
          const minutes = String(date.getUTCMinutes()).padStart(2, "0");
          return `${hours}:${minutes}`;
        },
      },
    },
    yAxis: {
      type: "value",
      scale: true,
      axisLabel: {
        formatter: (value) => (Math.round(value * 100) / 100).toFixed(2),
      },
    },
    series: [
      {
        name: data.name || data.metric_id || data.entity_id,
        type: chartType,
        smooth: seriesSmooth,
        showSymbol: false,
        areaStyle: { color: chartAreaColor},
        lineStyle: { color: chartLineColor, width: 2 },
        itemStyle: { color: chartLineColor },
        data: seriesData,
        ...chartOptions,
      },
    ],
  });
}

async function handleMetricChange() {
  if (!metricSelect.value) {
    return;
  }
  setQueryParam("metric_id", metricSelect.value);
  await fetchSeries();
}

metricSelect.addEventListener("change", () => {
  handleMetricChange().catch((err) => {
    console.error(err);
  });
});

loadButton.addEventListener("click", () => {
  handleMetricChange().catch((err) => {
    console.error(err);
  });
});

fetchMetrics()
  .then(() => {
    const metricId = getQueryParam("metric_id");
    if (metricId) {
      metricSelect.value = metricId;
      handleMetricChange().catch((err) => {
        console.error(err);
      });
    }
  })
  .catch((err) => {
    console.error(err);
  });

const now = new Date();
const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
if (!startInput.value) {
  startPicker.setDate(last24h, true);
}
if (!endInput.value) {
  endPicker.setDate(now, true);
}

quickButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const hours = Number(button.dataset.hours || 0);
    if (hours > 0) {
      applyQuickRange(hours);
    }
  });
});

window.addEventListener("resize", () => {
  chart.resize();
});
