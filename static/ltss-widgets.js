import { createLtssClient } from "./ltss-client.js";

const cards = Array.from(document.querySelectorAll(".ltss-card"));
if (cards.length) {
  const config = window.LTSS_CONFIG || {};
  const defaultHours = Number(config.defaultHours ?? 24);
  const client = createLtssClient({ apiUrl: config.apiUrl || undefined });

  const themeVars = getComputedStyle(document.documentElement);
  const grayscaleSeries = [
    "#d0d0d0",
    "#b0b0b0",
    "#909090",
    "#707070",
    "#505050",
  ];
  const cssVar = (name) => themeVars.getPropertyValue(name).trim();
  const chartLineColor = cssVar("--chart-line") || grayscaleSeries[0];
  const chartAreaColor = cssVar("--chart-area") || "rgba(208, 208, 208, 0.2)";
  const chartGridColor = cssVar("--chart-grid") || "rgba(208, 208, 208, 0.2)";
  const chartTextColor = cssVar("--chart-text") || "#e0e0e0";
  const themeSeriesColors = [
    cssVar("--chart-series-1"),
    cssVar("--chart-series-2"),
    cssVar("--chart-series-3"),
    cssVar("--chart-series-4"),
    cssVar("--chart-series-5"),
  ].filter(Boolean);
  const configSeriesColors = Array.isArray(config.seriesColors)
    ? config.seriesColors.filter(Boolean)
    : [];
  const baseSeriesColors = themeSeriesColors.length
    ? themeSeriesColors
    : grayscaleSeries;
  const seriesColors = configSeriesColors.length
    ? configSeriesColors
    : [
        chartLineColor,
        ...baseSeriesColors.filter((color) => color !== chartLineColor),
      ];
  const charts = [];

  function formatNumber(value) {
    if (value == null) {
      return "";
    }
    return (Math.round(Number(value) * 100) / 100).toFixed(2);
  }

  function formatTimeLabel(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    const hours = String(date.getUTCHours()).padStart(2, "0");
    const minutes = String(date.getUTCMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
  }

  function buildRange(hours) {
    const end = new Date();
    const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
    return {
      start: start.toISOString(),
      end: end.toISOString(),
    };
  }

  function setStatus(statusEl, message) {
    if (!statusEl) {
      return;
    }
    statusEl.textContent = message || "";
    statusEl.classList.toggle("is-hidden", !message);
  }

  function setTextValue(textEl, value) {
    if (!textEl) {
      return;
    }
    textEl.textContent = value || "";
    textEl.classList.toggle("is-hidden", !value);
  }

  async function resolveMetrics() {
    try {
      return await client.fetchMetrics();
    } catch (error) {
      console.error(error);
      return [];
    }
  }

  function getMetricIds(card, fallbackQueue) {
    const rawList = card.dataset.metricIds;
    if (rawList) {
      return rawList
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    }

    const single = card.dataset.metricId || fallbackQueue.shift();
    return single ? [single] : [];
  }

  async function renderCard(card, metricIds, metricMetas) {
    const chartEl = card.querySelector(".ltss-chart-canvas");
    const textEl = card.querySelector(".ltss-chart-text");
    const statusEl = card.querySelector(".ltss-chart-status");
    const headerEl = card.querySelector(".ltss-card-header");
    const titleEl = card.querySelector(".ltss-card-title");
    const subtitleEl = card.querySelector(".ltss-card-subtitle");
    if (!chartEl) {
      return;
    }

    const latestEl =
      card.querySelector(".ltss-card-latest") ||
      (() => {
        if (!headerEl) {
          return null;
        }
        const badge = document.createElement("span");
        badge.className = "ltss-card-latest";
        headerEl.appendChild(badge);
        return badge;
      })();

    const hours = Number(card.dataset.hours || defaultHours || 24);
    if (!subtitleEl || !subtitleEl.textContent.trim()) {
      const subtitleText = `Last ${hours}h`;
      if (headerEl) {
        if (subtitleEl) {
          subtitleEl.textContent = subtitleText;
        } else {
          const newSubtitleEl = document.createElement("p");
          newSubtitleEl.className = "ltss-card-subtitle";
          newSubtitleEl.textContent = subtitleText;
          headerEl.appendChild(newSubtitleEl);
        }
      }
    }

    if (!titleEl || !titleEl.textContent.trim()) {
      const resolvedTitle = (() => {
        const customTitle = card.dataset.title;
        if (customTitle) {
          return customTitle;
        }
        if (metricMetas.length === 1 && metricMetas[0]?.name) {
          return metricMetas[0].name;
        }
        if (metricIds.length === 1) {
          return metricIds[0];
        }
        if (metricMetas.length > 1) {
          return metricMetas
            .map((metric) => metric?.name || metric?.metric_id)
            .filter(Boolean)
            .join(" + ");
        }
        return "";
      })();

      if (resolvedTitle && headerEl) {
        if (titleEl) {
          titleEl.textContent = resolvedTitle;
        } else {
          const newTitleEl = document.createElement("h3");
          newTitleEl.className = "ltss-card-title";
          newTitleEl.textContent = resolvedTitle;
          headerEl.prepend(newTitleEl);
        }
      }
    }

    if (!metricIds.length) {
      setStatus(statusEl, "Missing metric_id");
      return;
    }

    const range = hours > 0 ? buildRange(hours) : null;
    const paramsBase = range ? { start: range.start, end: range.end } : {};

    setStatus(statusEl, "Loading...");
    setTextValue(textEl, "");

    try {
      const results = await Promise.allSettled(
        metricIds.map((metricId) =>
          client.fetchTimeseries({ metric_id: metricId, ...paramsBase }),
        ),
      );
      const seriesResponses = results
        .filter((result) => result.status === "fulfilled")
        .map((result) => result.value);
      const failedCount = results.length - seriesResponses.length;

      if (!seriesResponses.length) {
        setStatus(statusEl, "Failed to load data");
        return;
      }

      if (seriesResponses.length === 1 && seriesResponses[0].type === "text") {
        chartEl.style.display = "none";
        setTextValue(
          textEl,
          seriesResponses[0].value == null
            ? "No data"
            : String(seriesResponses[0].value),
        );
        setStatus(statusEl, "");
        if (latestEl) {
          latestEl.textContent = "";
          latestEl.classList.add("is-hidden");
        }
        return;
      }

      if (seriesResponses.some((series) => series.type === "text")) {
        setStatus(
          statusEl,
          "Text metrics cannot be mixed in multi-series charts",
        );
        return;
      }

      if (card.classList.contains("ltss-card--value")) {
        chartEl.style.display = "none";
        const primarySeries = seriesResponses[0];
        const points = primarySeries?.series || [];
        let latestValue = "";
        for (let i = points.length - 1; i >= 0; i -= 1) {
          const value = points[i]?.[1];
          if (value !== null && value !== undefined && value !== "") {
            const unit = primarySeries?.unit ? ` ${primarySeries.unit}` : "";
            latestValue = `${formatNumber(value)}${unit}`;
            break;
          }
        }
        setTextValue(textEl, latestValue || "No data");
        if (latestEl) {
          latestEl.textContent = "";
          latestEl.classList.add("is-hidden");
        }
        setStatus(statusEl, "");
        return;
      }

      chartEl.style.display = "block";
      setTextValue(textEl, "");

      const chartOptions = { ...seriesResponses[0].chart_options } || {};
      delete chartOptions.smooth;
      const seriesData = seriesResponses.flatMap(
        (series) => series.series || [],
      );

      const chart = echarts.init(chartEl);
      charts.push(chart);

      chart.setOption({
        grid: { left: 16, right: 16, top: 16, bottom: 24, containLabel: true },
        tooltip: {
          trigger: "axis",
          valueFormatter: (value) => formatNumber(value),
        },
        legend:
          seriesResponses.length > 1
            ? {
                textStyle: { color: chartTextColor },
              }
            : undefined,
        xAxis: {
          type: "time",
          axisLabel: {
            formatter: (value) => formatTimeLabel(value),
            color: chartTextColor,
          },
          axisLine: { lineStyle: { color: chartGridColor } },
          splitLine: { lineStyle: { color: chartGridColor } },
        },
        yAxis: {
          type: "value",
          scale: true,
          axisLabel: {
            formatter: (value) => formatNumber(value),
            color: chartTextColor,
          },
          axisLine: { lineStyle: { color: chartGridColor } },
          splitLine: { lineStyle: { color: chartGridColor } },
        },
        series: seriesResponses.map((series, index) => {
          const seriesOptions = { ...series.chart_options } || {};
          const metricType = series.type || "line";
          const seriesSmooth = seriesOptions.smooth || false;
          delete seriesOptions.smooth;

          const color = seriesColors[index % seriesColors.length];
          const seriesItem = {
            name: series.name || series.metric_id || series.entity_id,
            type: metricType,
            smooth: seriesSmooth,
            showSymbol: false,
            lineStyle: { color, width: 2 },
            itemStyle: { color },
            data: series.series || [],
            ...seriesOptions,
            ...chartOptions,
          };

          if (index === 0) {
            seriesItem.areaStyle = { color: chartAreaColor };
          }

          return seriesItem;
        }),
      });

      if (latestEl) {
        latestEl.classList.remove("is-hidden");
        const primarySeries = seriesResponses[0];
        const points = primarySeries?.series || [];
        let latestValue = "";
        for (let i = points.length - 1; i >= 0; i -= 1) {
          const value = points[i]?.[1];
          if (value !== null && value !== undefined && value !== "") {
            const unit = primarySeries?.unit ? ` ${primarySeries.unit}` : "";
            latestValue = `${formatNumber(value)}${unit}`;
            break;
          }
        }
        latestEl.textContent = latestValue;
      }

      if (failedCount > 0) {
        setStatus(statusEl, `Missing ${failedCount} series`);
      } else {
        setStatus(statusEl, seriesData.length ? "" : "No data");
      }
    } catch (error) {
      console.error(error);
      setStatus(statusEl, "Failed to load data");
    }
  }

  (async () => {
    const metrics = await resolveMetrics();
    const fallbackQueue = metrics.map((metric) => metric.metric_id);

    await Promise.all(
      cards.map(async (card) => {
        const metricIds = getMetricIds(card, fallbackQueue);
        const metricMetas = metricIds.map((metricId) =>
          metrics.find((metric) => metric.metric_id === metricId),
        );
        await renderCard(card, metricIds, metricMetas);
      }),
    );
  })();

  window.addEventListener("resize", () => {
    charts.forEach((chart) => chart.resize());
  });
}
