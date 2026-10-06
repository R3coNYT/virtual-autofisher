/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: { ocean: '#0a1628', accent: '#22d3ee', turquoise: '#2dd4bf' }
    }
  },
  plugins: []
}
