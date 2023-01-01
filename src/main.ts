import * as turf from '@turf/turf';
import geojson2h3 from 'geojson2h3';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';

declare global {
	interface Window {
		map: maplibregl.Map;
	}
}

const MAPTILER_API_KEY = import.meta.env.VITE_MAPTILER_API_KEY;
const MAX_MAP_ZOOM = 22
const MAX_H3_RESOLUTION = 15;

const [initialLng = -87.8, initialLat = 41.9, initialZoom = 10] =
	location.hash.slice(1).split(',').filter(Boolean).map(parseFloat);

import('maplibre-gl').then(maplibregl => {
	const map = new maplibregl.Map({
		container: document.getElementById('map')!,
		style: `https://api.maptiler.com/maps/voyager/style.json?key=${MAPTILER_API_KEY}`,
		center: [initialLng, initialLat],
		zoom: initialZoom,
		minZoom: 2,
	});

	map.on('load', () => {
		// const topLayerId = map.getStyle().layers.find(layer => layer.type === 'symbol')?.id;
		const topLayerId = 'boundary_country_outline';

		map.addSource('grid', {
			type: 'geojson',
			data: turf.featureCollection([]),
		});

		map.addSource('view', {
			type: 'geojson',
			data: turf.featureCollection([]),
		});

		map.addLayer({
			id: 'fill',
			type: 'fill',
			source: 'grid',
			paint: {
				'fill-color': 'transparent',
			},
			filter: ['==', '$type', 'Polygon'],
		}, topLayerId);

		map.addLayer({
			id: 'line',
			type: 'line',
			source: 'grid',
			paint: {
				'line-color': ['case', ['has', 'crossesAntimeridian'], 'red', 'gray'],
				'line-opacity': 1,
				'line-width': ['case', ['boolean', ['feature-state', 'hovered'], false], 3, 0.5],
			},
			filter: ['==', '$type', 'Polygon'],
		}, topLayerId);

		map.addLayer({
			id: 'view',
			type: 'line',
			source: 'view',
			paint: {
				'line-color': 'violet',
				'line-opacity': 1,
				'line-width': 3,
			},
			filter: ['==', '$type', 'Polygon'],
		}, topLayerId);

		refreshGrid(map);
	});

	let hoveredFeatureId: GeoJSON.Feature['id'];
	map.on('mousemove', 'fill', event => {
		if (hoveredFeatureId && hoveredFeatureId !== event.features?.[0].id) {
			map.setFeatureState({ source: 'grid', id: hoveredFeatureId }, { hovered: false });
			hoveredFeatureId = undefined;
		}
		if (!hoveredFeatureId) {
			hoveredFeatureId = event.features?.[0].id;
			if (hoveredFeatureId) {
				map.getCanvas().style.cursor = 'pointer';
				map.setFeatureState({ source: 'grid', id: hoveredFeatureId }, { hovered: true });
			}
		}
	}).on('mouseleave', 'fill', () => {
		map.getCanvas().style.cursor = '';
		if (hoveredFeatureId) {
			map.setFeatureState({ source: 'grid', id: hoveredFeatureId }, { hovered: false });
		}
	});

	map.on('click', 'fill', event => {
		const data = {
			id: event.features?.[0].id?.toString(16),
			geometry: event.features?.[0].geometry,
			properties: event.features?.[0].properties,
		};
		console.log(JSON.stringify(data, null, 2));
	});

	map.on('dblclick', 'fill', event => {
		if (event.features?.[0]) {
			event.preventDefault();
			const [lng1, lat1, lng2, lat2] = turf.bbox(event.features[0]);
			setTimeout(() => map.fitBounds([lng1, lat1, lng2, lat2], { padding: 20 }));
		}
	});

	map.on('move', async event => {
		if (!event.originalEvent?.altKey) {
			rememberPosition(map);
			refreshGrid(map);
		};
	});

	window.map = map;
});

function rememberPosition(map: maplibregl.Map) {
	const position = [
		...map.getCenter().toArray(),
		map.getZoom()
	].map(n => n.toFixed(2));
	location.hash = position.join(',');
}

function refreshGrid(map: maplibregl.Map) {
	const view = getAreaInView(map);
	const zoom = map.getZoom();
	const grid = getGrid(view, zoom);
	(map.getSource('grid') as maplibregl.GeoJSONSource).setData(grid);
	(map.getSource('view') as maplibregl.GeoJSONSource).setData(view);
}

function getAreaInView(map: maplibregl.Map) {
	const { width, height } = map.getCanvas();
	const cUL = map.unproject([0, 0]).toArray();
	const cUR = map.unproject([width / devicePixelRatio, 0]).toArray();
	const cLR = map.unproject([width / devicePixelRatio, height / devicePixelRatio]).toArray();
	const cLL = map.unproject([0, height / devicePixelRatio]).toArray();
	const viewLine = turf.lineString([cUL, cUR, cLR, cLL, cUL]);
	return turf.lineToPolygon(viewLine) as GeoJSON.Feature<GeoJSON.Polygon>;
}

function getGrid(view: GeoJSON.Feature<GeoJSON.Polygon>, zoom: number) {
	const secondView: GeoJSON.Feature<GeoJSON.Polygon> = turf.clone(view);
	const secondSign = Math.sign(secondView.geometry.coordinates[0][0][0]) * -1;
	turf.coordEach(secondView, coord => coord[0] += 360 * secondSign);
	const doubleView = turf.featureCollection([view, secondView]);
	const resolution = Math.round(zoom / MAX_MAP_ZOOM * MAX_H3_RESOLUTION);
	const hexagonIds = geojson2h3.featureToH3Set(doubleView, resolution);
	const grid = geojson2h3.h3SetToFeatureCollection(hexagonIds) as GeoJSON.FeatureCollection<GeoJSON.Polygon>;
	for (let i = 0; i < grid.features.length; i += 1) {
		const feature = grid.features[i];
		feature.id = Math.round(Math.random() * Number.MAX_SAFE_INTEGER);
		modifyToRespectAntimeridian(feature);
	}
	return grid;
}

function modifyToRespectAntimeridian(feature: GeoJSON.Feature<GeoJSON.Polygon>) {
	let previousCoord: GeoJSON.Point['coordinates'] | null = null;
	turf.coordEach(feature, currentCoord => {
		const onTheAntimeridianSide = Math.abs(currentCoord[0]) > 90;
		if (previousCoord && onTheAntimeridianSide) {
			const correctSign = Math.sign(previousCoord[0]);
			if (Math.sign(currentCoord[0]) !== correctSign) {
				currentCoord[0] += 360 * correctSign;
				feature.properties ??= {};
				feature.properties.crossesAntimeridian = true;
			}
		}
		previousCoord = currentCoord;
	});
}
