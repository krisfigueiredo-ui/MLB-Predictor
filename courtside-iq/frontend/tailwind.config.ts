import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: { 950: "#050913", 900: "#070D1A", 850: "#0A1222", 800: "#0D172B", 700: "#132038", 600: "#1B2B48", 500: "#26395C" },
        line: "#1A2A46",
        volt: { DEFAULT: "#2F7BFF", 400: "#5A97FF", 300: "#8AB6FF", 600: "#1F5FE0" },
        cyan: { DEFAULT: "#22D3EE", 400: "#4BDDF2" },
        mist: { DEFAULT: "#E6EDF7", 300: "#B7C4DA", 400: "#8A9BB8", 500: "#647696" },
        gain: "#22C55E",
        loss: "#F43F5E",
        flare: "#FF8A3D",
        gold: "#F5C451",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"],
        display: ["var(--font-display)", "var(--font-sans)", "ui-sans-serif", "sans-serif"],
      },
      boxShadow: {
        panel: "0 0 0 1px rgba(47,123,255,0.06), 0 10px 30px -12px rgba(0,0,0,0.6)",
        glow: "0 0 24px -4px rgba(47,123,255,0.45)",
      },
      keyframes: {
        marquee: { "0%": { transform: "translateX(0)" }, "100%": { transform: "translateX(-50%)" } },
        pulseDot: { "0%,100%": { opacity: "1" }, "50%": { opacity: "0.35" } },
        shimmer: { "0%": { backgroundPosition: "-400px 0" }, "100%": { backgroundPosition: "400px 0" } },
      },
      animation: {
        marquee: "marquee 90s linear infinite",
        pulseDot: "pulseDot 1.4s ease-in-out infinite",
        shimmer: "shimmer 1.6s linear infinite",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
export default config;
