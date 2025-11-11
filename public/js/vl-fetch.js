// Manually implementing the parser
function parseCSV(text) {
  const [headerLine, ...lines] = text.trim().split("\n");
  const headers = headerLine.split(",").map((h) => h.trim());

  return lines.map((line) => {
    const values = line.split(",").map((v) => v.trim());
    return headers.reduce((obj, header, i) => {
      obj[header] = isNaN(values[i]) ? values[i] : +values[i];
      return obj;
    }, {});
  });
}

// Fetching data
fetch("data.csv")
  .then((r) => r.text())
  .then((text) => {
    const data = parseCSV(text);

    // Vega-lite spec
    const spec2 = {
      data: { values: data },
      mark: "bar",
      encoding: {
        x: { field: "category", type: "nominal" },
        y: { field: "value", type: "quantitative" },
      },
    };

    // Vega-embed to attach spec to the HTML div
    vegaEmbed("#vl-fetch", spec2, { renderer: "canvas", actions: false });
  })
  .catch((err) => console.error("Error loading CSV:", err));
