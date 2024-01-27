import * as turf from '@turf/turf';
import geojson2h3 from 'geojson2h3';
import MapLibreGL from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';

const MAPTILER_API_KEY = import.meta.env.VITE_MAPTILER_API_KEY;
const MAX_MAP_ZOOM = 22
const MAX_H3_RESOLUTION = 15;

const [initialLng = -87.8, initialLat = 41.9, initialZoom = 10] =
	location.hash.slice(1).split(',').filter(Boolean).map(parseFloat);

const map = new MapLibreGL.Map({
	container: document.getElementById('map')!,
	style: `https://api.maptiler.com/maps/voyager/style.json?key=${MAPTILER_API_KEY}`,
	center: [initialLng, initialLat],
	zoom: initialZoom,
});

map.on('load', () => {
	// const topLayerId = map.getStyle().layers.find(layer => layer.type === 'symbol')?.id;
	const topLayerId = 'boundary_country_outline';

	map.addSource('square-grid', { type: 'geojson', data: turf.featureCollection([]) });
	map.addSource('h3-grid', { type: 'geojson', data: turf.featureCollection([]) });
	map.addSource('viewbox', { type: 'geojson', data: turf.featureCollection([]) });

	map.addLayer({
		id: 'square-grid-lines',
		type: 'line',
		source: 'square-grid',
		paint: {
			'line-color': 'gray',
			'line-width': 0.2,
		},
		filter: ['!', ['has', 'closeToPole']],
	}, topLayerId);

	map.addLayer({
		id: 'h3-grid-fill',
		type: 'fill',
		source: 'h3-grid',
		paint: {
			'fill-color': 'transparent',
		},
	}, topLayerId);

	map.addLayer({
		id: 'h3-grid-lines',
		type: 'line',
		source: 'h3-grid',
		paint: {
			'line-color': ['case', ['has', 'crossesAntimeridian'], 'red', 'gray'],
			'line-opacity': 1,
			'line-width': ['case', ['boolean', ['feature-state', 'hovered'], false], 2, 0.4],
		},
		filter: ['!', ['has', 'closeToPole']],
	}, topLayerId);

	map.addLayer({
		id: 'viewbox',
		type: 'line',
		source: 'viewbox',
		paint: {
			'line-color': 'violet',
			'line-width': 2,
		},
	}, topLayerId);

	refreshGrid(map);
});

let hoveredFeatureId: GeoJSON.Feature['id'];
map.on('mousemove', 'h3-grid-fill', event => {
	if (hoveredFeatureId && hoveredFeatureId !== event.features?.[0].id) {
		map.setFeatureState({ source: 'h3-grid', id: hoveredFeatureId }, { hovered: false });
		hoveredFeatureId = undefined;
	}
	if (!hoveredFeatureId) {
		hoveredFeatureId = event.features?.[0].id;
		if (hoveredFeatureId) {
			map.getCanvas().style.cursor = 'pointer';
			map.setFeatureState({ source: 'h3-grid', id: hoveredFeatureId }, { hovered: true });
		}
	}
}).on('mouseleave', 'h3-grid-fill', () => {
	map.getCanvas().style.cursor = '';
	if (hoveredFeatureId) {
		map.setFeatureState({ source: 'h3-grid', id: hoveredFeatureId }, { hovered: false });
	}
});

map.on('click', 'h3-grid-fill', event => {
	const data = {
		id: event.features?.[0].id?.toString(16),
		geometry: event.features?.[0].geometry,
		properties: event.features?.[0].properties,
	};
	console.info(JSON.stringify(data, null, 2));
});

map.on('dblclick', 'h3-grid-fill', event => {
	if (event.features?.[0]) {
		event.preventDefault();
		const [lng1, lat1, lng2, lat2] = turf.bbox(event.features[0]);
		map.fitBounds([lng1, lat1, lng2, lat2]);
	}
});

map.on('move', async event => {
	if (!event.originalEvent?.altKey) {
		rememberPosition(map);
		refreshGrid(map);
	};
});

let rememberPositionTimeout = 0;
function rememberPosition(map: maplibregl.Map) {
	clearTimeout(rememberPositionTimeout);
	rememberPositionTimeout = setTimeout(() => {
		const position = [
			...map.getCenter().toArray(),
			map.getZoom()
		].map(n => n.toFixed(2));
		location.hash = position.join(',');
	}, 500);
}

function refreshGrid(map: maplibregl.Map) {
	const view = getAreaInView(map);
	(map.getSource('viewbox') as maplibregl.GeoJSONSource).setData(view);

	const zoom = map.getZoom();
	const chunkSize = getChunkSize(view);

	const chunks = getChunks(view);
	// (map.getSource('square-grid') as maplibregl.GeoJSONSource).setData(chunks);

	const grid = getGrid(chunks, chunkSize, zoom);
	(map.getSource('h3-grid') as maplibregl.GeoJSONSource).setData(grid);
}

function getAreaInView(map: maplibregl.Map) {
	const PER_SIDE = 3;
	const relativePoints = [
		...Array(PER_SIDE).fill(null).map((_, i) => [i / (PER_SIDE), 0]),
		...Array(PER_SIDE).fill(null).map((_, i) => [1, i / (PER_SIDE)]),
		...Array(PER_SIDE).fill(null).map((_, i) => [(PER_SIDE - i) / (PER_SIDE), 1]),
		...Array(PER_SIDE).fill(null).map((_, i) => [0, (PER_SIDE - i) / (PER_SIDE)]),
	];

	const { width, height } = map.getCanvas();
	const projectedPoints = relativePoints.map(([x, y]) => {
		return map.unproject([
			x * width / devicePixelRatio,
			y * height / devicePixelRatio,
		]).toArray();
	});

	const viewLine = turf.lineString(projectedPoints);
	return turf.lineToPolygon(viewLine) as GeoJSON.Feature<GeoJSON.Polygon>;
}

function getChunkSize(view: GeoJSON.Feature<GeoJSON.Polygon>) {
	const scaled = turf.transformScale(view, 1/10);
	const scaledBox = turf.bbox(scaled);
	const width = Math.abs(scaledBox[2] - scaledBox[0]);
	const height = Math.abs(scaledBox[3] - scaledBox[1]);
	return Math.min(width, height);
}

function getChunks(view: GeoJSON.Feature<GeoJSON.Polygon>) {
	// `featureToH3Set` doesn't work below -180, above +180, or on any polygons wider than 180°.
	// https://github.com/uber/h3/issues/210

	const scaled = turf.transformScale(view, 1/10);
	const bbox = turf.bbox(scaled);
	const width = Math.abs(bbox[2] - bbox[0]);
	const height = Math.abs(bbox[3] - bbox[1]);
	const side = Math.min(width, height);
	return turf.squareGrid(turf.bbox(view), side, { units: 'degrees', mask: view });
}

let cellId = 0;

function getGrid(chunks: GeoJSON.FeatureCollection<GeoJSON.Polygon>, chunkSize: number, zoom: number) {
	const resolution = Math.round(Math.max(zoom, 0) / MAX_MAP_ZOOM * MAX_H3_RESOLUTION);
	const hexagonIds = new Set<string>();

	chunks.features.forEach(chunk => {
		const bigChunk = turf.buffer(chunk, chunkSize, { units: 'degrees' });
		bigChunk.properties ??= {};
		const cellIds = geojson2h3.featureToH3Set(bigChunk, resolution);
		cellIds.forEach(id => hexagonIds.add(id));
	});

	const grid = geojson2h3.h3SetToFeatureCollection(Array.from(hexagonIds), id => ({ id })) as GeoJSON.FeatureCollection<GeoJSON.Polygon>;

	grid.features.forEach(cell => {
		cell.id = cellId++ % Number.MAX_SAFE_INTEGER;
		modifyToIndicateCloseToPole(cell);
		modifyToRespectAntimeridian(cell);
	});

	return grid;
}

function modifyToIndicateCloseToPole(feature: GeoJSON.Feature<GeoJSON.Polygon>) {
	const CLOSE_TO_POLE = 85;
	turf.coordEach(feature, currentCoord => {
		if (Math.abs(currentCoord[1]) > CLOSE_TO_POLE) {
			feature.properties ??= {};
			feature.properties.closeToPole = true;
		}
	});
}

function modifyToRespectAntimeridian(feature: GeoJSON.Feature<GeoJSON.Polygon>) {
	let previousCoord: GeoJSON.Point['coordinates'] | null = null;
	turf.coordEach(feature, currentCoord => {
		const onTheAntimeridianSide = Math.abs(currentCoord[0]) > 90;
		if (previousCoord && onTheAntimeridianSide) {
			const centerSign = Math.sign(previousCoord[0]);
			if (Math.sign(currentCoord[0]) !== centerSign) {
				currentCoord[0] += 360 * centerSign;
				feature.properties ??= {};
				feature.properties.crossesAntimeridian = true;
			}
		}
		previousCoord = currentCoord;
	});
}
