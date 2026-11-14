// Natural-feature rules shared by service and regional basemaps (MVR-P7 stage A).
export const NATURAL_FEATURE_STYLE = Object.freeze({
  water: '#286b9b', nature: '#376844', peak: '#59624f', halo: '#ffffff', haloWidth: 2,
  oceanSize: 15, lakeSize: 14, riverSize: 12, peakSize: 12, natureSize: 11,
  lakeZoom: 9, riverZoom: 9, riverLabelZoom: 11, peakZoom: 11, natureZoom: 8,
  builtInRiverZoom: 14, largeParkMaxZoom: 10, poiLakeZoom: 12,
  riverLineColor: '#8cc8f5', riverWidthStart: 1, riverWidthEnd: 2.5, riverWidthEndZoom: 13,
});
const OCEANS = Object.freeze(['ocean', 'bay', 'strait', 'fjord']);
const LAKES = Object.freeze(['sea', 'lake', 'water']);
const POI_LAKES = Object.freeze(['water']);
const PEAKS = Object.freeze(['peak', 'volcano']);
const NATURE = Object.freeze(['forest', 'nature_reserve', 'national_park', 'park', 'protected_area']);
const S = NATURAL_FEATURE_STYLE;
const named = (feature, lang) => feature.props[`name:${lang}`] || feature.props.name;
const sourceVisible = (zoom, feature) => zoom >= Number(feature.props.min_zoom ?? 0);

export function peakLabel(feature, lang = 'en') {
  const name = named(feature, lang);
  if (!name) return '';
  const elevation = feature.props.elevation;
  const hasElevation = elevation !== null && elevation !== undefined && elevation !== '' && Number.isFinite(Number(elevation));
  return `▲ ${name}${hasElevation ? ` · ${Math.round(Number(elevation))} m` : ''}`;
}

export function buildPaintRules(protomaps, flavor) {
  const rules = [...protomaps.paintRules(flavor)];
  const river = {
    dataLayer: 'water', minzoom: S.riverZoom, maxzoom: S.builtInRiverZoom,
    filter: (zoom, feature) => zoom >= S.riverZoom && zoom < S.builtInRiverZoom && feature.geomType === 2 && feature.props.kind === 'river',
    symbolizer: new protomaps.LineSymbolizer({ color: S.riverLineColor,
      width: zoom => S.riverWidthStart + (Math.min(Math.max(zoom, S.riverZoom), S.riverWidthEndZoom) - S.riverZoom)
        / (S.riverWidthEndZoom - S.riverZoom) * (S.riverWidthEnd - S.riverWidthStart) }),
  };
  // Keep rivers below roads, after the built-in water passes.
  rules.splice(rules.findLastIndex(rule => rule.dataLayer === 'water') + 1, 0, river);
  return rules;
}

export function buildLabelRules(protomaps, flavor, lang = 'en') {
  const text = (fill, size) => ({ labelProps: [`name:${lang}`, 'name'], fill,
    font: `italic ${size}px sans-serif`, stroke: S.halo, width: S.haloWidth });
  const pointRule = (dataLayer, kinds, minzoom, size, fill, respectSourceZoom = true) => ({
    dataLayer, minzoom,
    filter: (zoom, feature) => zoom >= minzoom && feature.geomType === 1 && kinds.includes(feature.props.kind)
      && (!respectSourceZoom || sourceVisible(zoom, feature)) && Boolean(named(feature, lang)),
    symbolizer: new protomaps.CenteredTextSymbolizer(text(fill, size)),
  });
  const peak = pointRule('pois', PEAKS, S.peakZoom, S.peakSize, S.peak);
  const peakText = new protomaps.CenteredTextSymbolizer({ ...text(S.peak, S.peakSize), labelProps: ['natural_peak_label'] });
  // TextAttr callbacks select property keys only. Supply a derived property on a copy.
  peak.symbolizer = { place(layout, geom, feature) {
    return peakText.place(layout, geom, { ...feature, props: { ...feature.props, natural_peak_label: peakLabel(feature, lang) } });
  } };
  const nature = pointRule('pois', NATURE, S.natureZoom, S.natureSize, S.nature);
  const natureFilter = nature.filter;
  nature.filter = (zoom, feature) => natureFilter(zoom, feature) && (feature.props.kind !== 'park'
    || (feature.props.min_zoom != null && Number(feature.props.min_zoom) <= S.largeParkMaxZoom));
  return [
    // Earlier rules win collisions: reserve room for rivers before road/place labels.
    { dataLayer: 'water', minzoom: S.riverLabelZoom,
      filter: (zoom, feature) => zoom >= S.riverLabelZoom && feature.geomType === 2 && feature.props.kind === 'river'
        && sourceVisible(zoom, feature) && Boolean(named(feature, lang)),
      symbolizer: new protomaps.LineLabelSymbolizer(text(S.water, S.riverSize)) },
    ...protomaps.labelRules(flavor, lang).filter(rule => rule.dataLayer !== 'water'),
    pointRule('water', OCEANS, 0, S.oceanSize, S.water, false),
    pointRule('water', LAKES, S.lakeZoom, S.lakeSize, S.water, false),
    pointRule('pois', POI_LAKES, S.poiLakeZoom, S.lakeSize, S.water),
    peak, nature,
  ];
}
