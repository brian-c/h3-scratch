import * as turf from '@turf/turf';
import { UNITS, cellToLatLng, cellsToMultiPolygon, getHexagonEdgeLengthAvg, getResolution, latLngToCell } from 'h3-js';
import H3Layer from './h3-layer';

const LONG_PRESS_TIME = 500;

let instanceIdCounter = 0;

export default class H3SeletionLayer extends H3Layer {
	#id = instanceIdCounter++;

	#highlight = '#08f8';

	get highlight() {
		return this.#highlight;
	}

	set highlight(color: string) {
		this.#highlight = color;
		this.#redrawHighlight();
	}

	#geoJsonValue: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null = null;

	addTo(...args: Parameters<H3Layer['addTo']>) {
		super.addTo(...args);
		if (!this.map) return;

		this.map.addSource(`h3-selection-${this.#id}`, { type: 'geojson', data: turf.featureCollection([]) });

		this.map.addLayer({
			id: `h3-selection-fill-${this.#id}`,
			type: 'fill',
			source: `h3-selection-${this.#id}`,
			paint: {
				'fill-color': this.highlight,
			},
		}, this.topLayerId);

		this.map.getCanvas().addEventListener('pointerdown', this.#handlePointerDown);
	}

	remove(): void {
		this.map?.removeLayer(`h3-selection-fill-${this.#id}`);
		this.map?.removeSource(`h3-selection-${this.#id}`);
		this.map?.getCanvas().removeEventListener('pointerdown', this.#handlePointerDown);
		super.remove();
	}

	#handlePointerDown = (event: PointerEvent) => {
		if (!this.map) return;

		const map = this.map;
		const canvas = map.getCanvas();

		const initialDragPan = map.dragPan.isEnabled();
		const initialCursor = canvas.style.getPropertyValue('cursor');

		let didLongPress = false;
		let moved = false;
		let lastDraggedCell = '';

		const startingCell = this.#cellFromEvent(map, event);
		if (!startingCell) return;
		const method = this.#cellInValue(startingCell) ? this.#removeCellFromValue : this.#addCellToValue;
		console.log('In value', this.#cellInValue(startingCell));

		const longPressTimeout = setTimeout(() => {
			didLongPress = true;

			map.dragPan.disable();
			map.getCanvas().style.setProperty('cursor', 'crosshair');

			console.log('Long-pressed', startingCell, method.name);
			method.call(this, startingCell);
		}, LONG_PRESS_TIME);

		const handleMove = (event: PointerEvent) => {
			moved = true;

			if (!didLongPress) {
				clearTimeout(longPressTimeout);
				return;
			}

			const draggedCell = this.#cellFromEvent(map, event);
			if (!draggedCell) return;
			if (draggedCell === lastDraggedCell) return;
			// const inValue = this.#cellInValue(draggedCell);
			// const noChange = method === this.#addCellToValue === inValue;
			// if (noChange) return;
			method.call(this, draggedCell);
			console.log('Dragged across', draggedCell, method.name);
			lastDraggedCell = draggedCell;
		};

		const handleRelease = () => {
			clearTimeout(longPressTimeout);
			removeEventListener('pointermove', handleMove);
			removeEventListener('pointerup', handleRelease);

			if (didLongPress) {
				canvas.style.setProperty('cursor', initialCursor);
				if (initialDragPan) map.dragPan.enable();
			} else if (!moved) {
				console.log('Clicked', startingCell, method.name);
				method.call(this, startingCell);
			}
		};

		addEventListener('pointermove', handleMove);
		addEventListener('pointerup', handleRelease);
	};

	#cellFromEvent(map: maplibregl.Map, event: PointerEvent) {
		if (!this.map) return;
		const canvas = map.getCanvas();
		const rect = canvas.getBoundingClientRect();
		const { lng, lat } = map.unproject([event.clientX - rect.x, event.clientY - rect.y]);
		return latLngToCell(lat, lng, this.h3Resolution);
	}

	#cellInValue(cellId: string) {
		const [lat, lng] = cellToLatLng(cellId);
		const edgeLength = getHexagonEdgeLengthAvg(getResolution(cellId), UNITS.m);
		const dot = turf.circle([lng, lat], edgeLength / 2, { units: 'meters' });
		return Boolean(this.#geoJsonValue && turf.intersect(this.#geoJsonValue, dot));
	}

	#addCellToValue(cellId: string) {
		const [coords] = cellsToMultiPolygon([cellId], true);
		const cell = turf.polygon(coords);
		this.modifyToRespectAntimeridian(cell);
		this.#geoJsonValue = this.#geoJsonValue ? turf.union(this.#geoJsonValue, cell) : cell;
		this.#redrawHighlight();
	}

	#removeCellFromValue(cellId: string) {
		const [coords] = cellsToMultiPolygon([cellId], true);
		const cell = turf.polygon(coords);
		this.modifyToRespectAntimeridian(cell);
		this.#geoJsonValue = this.#geoJsonValue && turf.difference(this.#geoJsonValue, cell);
		this.#redrawHighlight();
	}

	#redrawHighlight() {
		if (!this.map) return;
		this.map.setPaintProperty(`h3-selection-fill-${this.#id}`, 'fill-color', this.highlight);
		const source = this.map.getSource(`h3-selection-${this.#id}`) as maplibregl.GeoJSONSource | undefined;
		source?.setData(this.#geoJsonValue ?? turf.featureCollection([]));
	}
}
