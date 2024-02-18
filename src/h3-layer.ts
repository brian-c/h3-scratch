import * as turf from '@turf/turf';
import geojson2h3 from 'geojson2h3';
import { polygonToCells } from 'h3-js';

const MAX_MAP_ZOOM = 22
const MAX_H3_RESOLUTION = 15;

let layerIdCounter = 0;
let cellIdCounter = 0;

export default class H3Layer {
	#id = layerIdCounter++;
	protected map: maplibregl.Map | null = null;
	#hoveredFeatureId: GeoJSON.Feature['id'] | null = null;
	protected h3Resolution = 0;
	protected topLayerId: string | undefined;

	get source() {
		return this.map?.getSource(`h3-grid-${this.#id}`) as maplibregl.GeoJSONSource | undefined;
	}

	get fillLayer() {
		return this.map?.getLayer(`h3-grid-fill-${this.#id}`);
	}

	addTo(map: maplibregl.Map, topLayerId?: string) {
		this.map = map;

		this.topLayerId = topLayerId ?? map.getStyle().layers.find(layer => layer.type === 'symbol')?.id;

		map.addSource(`h3-grid-${this.#id}`, { type: 'geojson', data: turf.featureCollection([]) });

		map.addLayer({
			id: `h3-grid-fill-${this.#id}`,
			type: 'fill',
			source: `h3-grid-${this.#id}`,
			paint: {
				'fill-color': 'transparent',
			},
		}, this.topLayerId);

		map.addLayer({
			id: `h3-grid-lines-${this.#id}`,
			type: 'line',
			source: `h3-grid-${this.#id}`,
			paint: {
				'line-color': ['case', ['has', 'crossesAntimeridian'], 'red', '#8884'],
				'line-opacity': 1,
				'line-width': ['case', ['boolean', ['feature-state', 'hovered'], false], 2, 0.4],
			},
			filter: ['!', ['has', 'closeToPole']],
		}, this.topLayerId);

		map.on('remove', this.remove);
		map.on('move', this.#handleMapMove);
		map.on('mousemove', `h3-grid-fill-${this.#id}`, this.#handleCellMove);
		map.on('mouseleave', `h3-grid-fill-${this.#id}`, this.#handleCellLeave);

		this.redraw();
	}

	remove() {
		if (!this.map) return;
		this.map.removeLayer(`h3-grid-lines-${this.#id}`);
		this.map.removeLayer(`h3-grid-fill-${this.#id}`);
		this.map.removeSource(`h3-grid-${this.#id}`);
		this.map = null;
	}

	on<E extends keyof maplibregl.MapLayerEventType>(
		event: E,
		callback: (event: maplibregl.MapLayerEventType[E], cellId: string) => void,
	) {
		const map = this.map;
		if (!map) return;

		function handler(event: maplibregl.MapLayerEventType[E]) {
			callback(event, event.features?.[0].properties.id);
		}

		map.on(event, `h3-grid-fill-${this.#id}`, handler);
		return () => map.off(event, handler);
	}

	#handleCellMove = (event: maplibregl.MapLayerEventType['mousemove']) => {
		if (!this.map) return;
		const feature = event.features?.[0];
		if (this.#hoveredFeatureId && this.#hoveredFeatureId !== feature?.id) {
			this.map.setFeatureState({ source: `h3-grid-${this.#id}`, id: this.#hoveredFeatureId }, { hovered: false });
			this.#hoveredFeatureId = undefined;
		}
		if (!this.#hoveredFeatureId) {
			if (feature) {
				this.#hoveredFeatureId = feature.id;
				this.map.setFeatureState({ source: `h3-grid-${this.#id}`, id: this.#hoveredFeatureId }, { hovered: true });
			}
		}
	};

	#handleCellLeave = () => {
		if (!this.map) return;
		if (this.#hoveredFeatureId) {
			this.map.setFeatureState({ source: `h3-grid-${this.#id}`, id: this.#hoveredFeatureId }, { hovered: false });
		}
	};

	#moveThrottle: 'yes' | 'no' | 'finishing' = 'no';
	#moveFinishTimeout = 0;
	#handleMapMove = (event: maplibregl.MapEventType['moveend']) => {
		clearTimeout(this.#moveFinishTimeout);
		if (this.#moveThrottle === 'yes') return;

		if (this.#moveThrottle !== 'finishing') {
			this.#moveThrottle = 'yes';
			setTimeout(() => {
				this.#moveThrottle = 'no';
				this.#moveFinishTimeout = setTimeout(() => {
					this.#moveThrottle = 'finishing';
					this.#handleMapMove(event);
					this.#moveThrottle = 'no';
				}, 100);
			}, 500);
		}

		if (!this.map || event.originalEvent?.altKey) return;
		this.redraw();
	};

	redraw() {
		if (!this.map) return;
		const view = this.#getAreaInView(this.map);
		const zoom = this.map.getZoom();
		const chunkSize = this.#getChunkSize(view);
		const chunks = this.#getChunks(view);
		const grid = this.#getGrid(chunks, chunkSize, zoom);
		(this.map.getSource(`h3-grid-${this.#id}`) as maplibregl.GeoJSONSource).setData(grid);
	}

	#getAreaInView(map: maplibregl.Map) {
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

	#getChunkSize(view: GeoJSON.Feature<GeoJSON.Polygon>) {
		const scaled = turf.transformScale(view, 1/10);
		const scaledBox = turf.bbox(scaled);
		const width = Math.abs(scaledBox[2] - scaledBox[0]);
		const height = Math.abs(scaledBox[3] - scaledBox[1]);
		return Math.min(width, height);
	}

	#getChunks(view: GeoJSON.Feature<GeoJSON.Polygon>) {
		// `featureToH3Set` doesn't work below -180, above +180, or on any polygons wider than 180°.
		// https://github.com/uber/h3/issues/210

		const scaled = turf.transformScale(view, 1/10);
		const bbox = turf.bbox(scaled);
		const width = Math.abs(bbox[2] - bbox[0]);
		const height = Math.abs(bbox[3] - bbox[1]);
		const side = Math.min(width, height);
		return turf.squareGrid(turf.bbox(view), side, { units: 'degrees', mask: view });
	}

	#getGrid(chunks: GeoJSON.FeatureCollection<GeoJSON.Polygon>, chunkSize: number, zoom: number) {
		this.h3Resolution = Math.round(Math.max(zoom, 0) / MAX_MAP_ZOOM * MAX_H3_RESOLUTION);
		const hexagonIds = new Set<string>();

		chunks.features.forEach(chunk => {
			const bigChunk = turf.buffer(chunk, chunkSize, { units: 'degrees' });
			bigChunk.properties ??= {};
			const cellIds = polygonToCells(bigChunk.geometry.coordinates, this.h3Resolution, true);
			cellIds.forEach(id => hexagonIds.add(id));
		});

		const grid = geojson2h3.h3SetToFeatureCollection(Array.from(hexagonIds), id => ({
			id,
		})) as GeoJSON.FeatureCollection<GeoJSON.Polygon>;

		grid.features.forEach(cell => {
			cell.id = cellIdCounter++;
			this.modifyToIndicateCloseToPole(cell);
			this.modifyToRespectAntimeridian(cell);
		});

		return grid;
	}

	protected modifyToIndicateCloseToPole(feature: GeoJSON.Feature<GeoJSON.Polygon>) {
		const CLOSE_TO_POLE = 85;
		turf.coordEach(feature, currentCoord => {
			if (Math.abs(currentCoord[1]) > CLOSE_TO_POLE) {
				feature.properties ??= {};
				feature.properties.closeToPole = true;
			}
		});
	}

	protected modifyToRespectAntimeridian(feature: GeoJSON.Feature<GeoJSON.Polygon>) {
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
}
