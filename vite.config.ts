import { visualizer } from 'rollup-plugin-visualizer';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [visualizer({
		emitFile: true,
		filename: 'stats.html',
	})],
});
