import type { Config } from "tailwindcss";
export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#08090C",
          900: "#0D0F14",
          850: "#11141B",
          800: "#161A22",
          750: "#1B2029",
          700: "#232936",
          600: "#323A4A",
        },
        line: { DEFAULT: "#1E242F", soft: "#171C25", strong: "#2C3442" },
        fg: { DEFAULT: "#E7E9EE", soft: "#B7BDC9", mute: "#8A919F", faint: "#5C6472" },
        flare: { DEFAULT: "#FFB224", soft: "#FFC85C", dim: "#8A5E10" },
        mint: { DEFAULT: "#3ECF9A", dim: "#14532D" },
        rose: { DEFAULT: "#F47067", dim: "#5B2220" },
        sky: { DEFAULT: "#6AA8FF", dim: "#1E3A5F" },
        lilac: { DEFAULT: "#B79CFF", dim: "#3B2E63" },
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      boxShadow: {
        panel: "0 1px 0 0 rgba(255,255,255,0.03) inset, 0 8px 24px -12px rgba(0,0,0,0.6)",
        pop: "0 12px 40px -12px rgba(0,0,0,0.7)",
      },
    },
  },
  plugins: [],
} satisfies Config;
