/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        copper: "#C8975A",
        darkbg: "#0E0B08",
        cardbg: "#1A1410",
      },
    },
  },
  plugins: [],
};