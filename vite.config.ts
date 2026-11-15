import { defineConfig } from "vite"
import { gui } from "@opencode/plugin/gui/vite"

// The GUI preset compiles Solid JSX and emits one CommonJS bundle
// (dist/gui-experimental.cjs) that OpenCode Desktop loads.
export default defineConfig({
  plugins: [gui()],
})
