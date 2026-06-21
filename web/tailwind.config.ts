import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        matcha: {
          50: "#f3f7ee", 100: "#e6efdc", 200: "#cfe0bd", 300: "#b2cd97",
          400: "#93b771", 500: "#79a155", 600: "#5f8341", 700: "#4a6735",
          800: "#3c532e", 900: "#324528",
        },
        clay: { 400: "#c98a6a", 500: "#b9734f", 600: "#9c5d3d" },
      },
      borderRadius: { xl: "0.875rem" },
    },
  },
  plugins: [],
};
export default config;
