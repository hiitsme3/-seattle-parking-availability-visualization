// Vega-Lite can read CSV directly if you give it a URL.
const spec3 = {
  data: { url: "data.csv" },
  mark: "bar",
  encoding: {
    x: { field: "category", type: "nominal" },
    y: { field: "value", type: "quantitative" },
  },
};

// Vega-embed to attach spec to the HTML div
vegaEmbed("#vl-url", spec3, { renderer: "canvas", actions: false });
