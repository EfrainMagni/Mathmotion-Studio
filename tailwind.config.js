/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { 950: '#141414', 900: '#191919', 800: '#1e1e1e', 700: '#252525', 600: '#323232' },
        bezel: '#323232',
        accent: { DEFAULT: '#5c9ef4', soft: '#29384b', light: '#aacbfb' },
        slate: {
          950: '#141414', 900: '#191919', 800: '#1e1e1e', 700: '#252525', 600: '#888888',
          500: '#a2a2a2', 400: '#b9b9b9', 300: '#d4d4d4', 200: '#dddddd', 100: '#e7e7e7',
        },
      },
      fontSize: { xs: ['11px', '1.35'], sm: ['12px', '1.4'] },
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
    },
  },
  plugins: [],
};
