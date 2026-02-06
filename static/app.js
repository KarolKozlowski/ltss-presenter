const metricSelect = document.getElementById("metric");
const startInput = document.getElementById("start");
const endInput = document.getElementById("end");
const loadButton = document.getElementById("load");

const chart = echarts.init(document.getElementById("chart"));

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

async function fetchMetrics() {
  const res = await fetch("api/metrics");
  const data = await res.json();
  metricSelect.innerHTML = "";

  for (const item of data) {
    const opt = document.createElement("option");
    opt.value = item.entity_id;
    const label = item.name || item.entity_id;
    opt.textContent = `${label} (${item.unit || ""})`;
    metricSelect.appendChild(opt);
  }
}

async function fetchSeries() {
  const params = new URLSearchParams({
    entity_id: metricSelect.value,
    value: "state",
  });
  if (startInput.value) params.set("start", startInput.value);
  if (endInput.value) params.set("end", endInput.value);

  const res = await fetch(`api/timeseries?${params.toString()}`);
  const data = await res.json();

  const labels = data.labels || [];
  const points = data.points || [];

  const seriesData = labels.map((label, index) => {
    const value = points[index];
    if (value == null) {
      return [label, null];
    }
    return [label, Math.round(value * 100) / 100];
  });

  chart.setOption({
    grid: { left: 28, right: 20, top: 16, bottom: 36 },
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
        name: `${data.entity_id}`,
        type: "line",
        showSymbol: false,
        areaStyle: { color: "rgba(36, 49, 214, 0.15)" },
        lineStyle: { color: "#2431d6", width: 2 },
        data: seriesData,
      },
    ],
  });
}

async function handleMetricChange() {
  if (!metricSelect.value) {
    return;
  }
  setQueryParam("entity_id", metricSelect.value);
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
    const entityId = getQueryParam("entity_id");
    if (entityId) {
      metricSelect.value = entityId;
      handleMetricChange().catch((err) => {
        console.error(err);
      });
    }
  })
  .catch((err) => {
    console.error(err);
  });

window.addEventListener("resize", () => {
  chart.resize();
});
