import MapLibreGL from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import H3SeletionLayer from './h3-selection-layer';

const MAPTILER_API_KEY = import.meta.env.VITE_MAPTILER_API_KEY;

const [initialLng = -87.8, initialLat = 41.9, initialZoom = 10] =
	location.hash.slice(1).split(',').filter(Boolean).map(parseFloat);

const map = new MapLibreGL.Map({
	container: document.getElementById('map')!,
	style: `https://api.maptiler.com/maps/voyager/style.json?key=${MAPTILER_API_KEY}`,
	center: [initialLng, initialLat],
	zoom: initialZoom,
});


map.on('load', () => {
	const topLayerId = 'boundary_country_outline';
	const h3Layer = new H3SeletionLayer();
	Object.assign(globalThis, { h3Layer });
	h3Layer.addTo(map, topLayerId);
	// h3Layer.onInput((...args: unknown[]) => console.info('INPUT', ...args));
	// h3Layer.onChange((...args: unknown[]) => console.info('CHANGE', ...args));
});

map.on('move', () => {
	rememberPosition(map);
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
