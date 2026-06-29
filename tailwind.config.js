/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./public/**/*.html", "./src/client/**/*.ts"],
  theme: {
    extend: {
      colors: {
        booze: {
          50: "#f3f1ff",
          100: "#e9e5ff",
          400: "#9d7bff",
          500: "#7c4dff",
          600: "#6a35f0",
          700: "#5826cc"
        }
      }
    }
  },
  plugins: []
};
