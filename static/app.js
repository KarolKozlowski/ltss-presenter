const metricSelect = document.getElementById("metric");
const startInput = document.getElementById("start");
const endInput = document.getElementById("end");
const loadButton = document.getElementById("load");
const metricText = document.getElementById("metric-text");

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

function formatNumber(value) {
  if (value == null) {
    return "";
  }
  return (Math.round(Number(value) * 100) / 100).toFixed(2);
}

function updateTextMetric(value) {
  const displayValue =
    value == null ? '<span class="metric-text-subtle">No data</span>' : value;
  metricText.innerHTML = displayValue;
  metricText.style.display = "flex";
  chart.getDom().style.display = "none";
  chart.clear();
}

function showChart() {
  metricText.innerHTML = "";
  metricText.style.display = "none";
  chart.getDom().style.display = "block";
}

function getDateParamValue(picker, fallbackInput) {
  const date = picker.selectedDates[0] || new Date(fallbackInput.value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

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

async function fetchConfig() {
  const res = await fetch("api/config");
  if (!res.ok) {
    return {};
  }
  return res.json();
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
  });
  const startValue = getDateParamValue(startPicker, startInput);
  const endValue = getDateParamValue(endPicker, endInput);
  if (startValue) params.set("start", startValue);
  if (endValue) params.set("end", endValue);

  const res = await fetch(`api/timeseries?${params.toString()}`);
  const data = await res.json();

  const chartOptions = { ...data.chart_options } || {};
  const metricType = data.type || "line";
  const seriesSmooth = chartOptions.smooth || false;
  delete chartOptions.smooth;
  const seriesData = data.series || [];

  if (metricType === "text") {
    updateTextMetric(data.value);
    return;
  }

  showChart();

  chart.setOption({
    grid: { left: 16, right: 16, top: 16, bottom: 16, containLabel: true },
    tooltip: {
      trigger: "axis",
      valueFormatter: (value) => formatNumber(value),
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
        formatter: (value) => formatNumber(value),
      },
    },
    series: [
      {
        name: data.name || data.metric_id || data.entity_id,
        type: metricType,
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
  .then(async () => {
    const config = await fetchConfig();
    const metricId = getQueryParam("metric_id") || config.default_metric;
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
