/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: [
    "./index.html",
    "./src/**/*.{js,jsx,ts,tsx}",
    "./node_modules/@tremor/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // === EXEVORI PALETTE ===
        bg: {
          primary: "#080C18",
          secondary: "#0F1626",
          card: "#111827",
          elevated: "#1F2937",
        },
        border: {
          DEFAULT: "rgba(255,255,255,0.08)",
          strong: "rgba(255,255,255,0.14)",
        },
        text: {
          primary: "#F9FAFB",
          secondary: "#9CA3AF",
          tertiary: "#6B7280",
        },
        brand: {
          DEFAULT: "#3B82F6",
          purple: "#8B5CF6",
          cyan: "#06B6D4",
          green: "#10B981",
          orange: "#F59E0B",
          red: "#EF4444",
          pink: "#EC4899",
        },
        // === SHADCN COLOR TOKENS ===
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",

        // === TREMOR PALETTE (mapped to brand) ===
        tremor: {
          brand: {
            faint: "#0F1626",
            muted: "#1E293B",
            subtle: "#3B82F6",
            DEFAULT: "#3B82F6",
            emphasis: "#60A5FA",
            inverted: "#FFFFFF",
          },
          background: { muted: "#0F1626", subtle: "#111827", DEFAULT: "#111827", emphasis: "#1F2937" },
          border: { DEFAULT: "rgba(255,255,255,0.08)" },
          ring: { DEFAULT: "#3B82F6" },
          content: {
            subtle: "#6B7280",
            DEFAULT: "#9CA3AF",
            emphasis: "#D1D5DB",
            strong: "#F9FAFB",
            inverted: "#080C18",
          },
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui"],
      },
      backdropBlur: { xs: "2px" },
      keyframes: {
        "accordion-down": { from: { height: 0 }, to: { height: "var(--radix-accordion-content-height)" } },
        "accordion-up": { from: { height: "var(--radix-accordion-content-height)" }, to: { height: 0 } },
        "fade-in": { from: { opacity: 0, transform: "translateY(8px)" }, to: { opacity: 1, transform: "translateY(0)" } },
        "shimmer": { from: { backgroundPosition: "0 0" }, to: { backgroundPosition: "-200% 0" } },
        "pulse-dot": { "0%, 100%": { boxShadow: "0 0 0 0 rgba(16,185,129,0.7)" }, "50%": { boxShadow: "0 0 0 6px rgba(16,185,129,0)" } },
        "ring-spin": { from: { transform: "rotate(0deg)" }, to: { transform: "rotate(360deg)" } },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "fade-in": "fade-in 0.4s cubic-bezier(0.16,1,0.3,1)",
        "shimmer": "shimmer 2s linear infinite",
        "pulse-dot": "pulse-dot 1.8s infinite",
        "ring-spin": "ring-spin 12s linear infinite",
      },
      boxShadow: {
        "glow-blue": "0 0 24px -4px rgba(59,130,246,0.5)",
        "glow-purple": "0 0 24px -4px rgba(139,92,246,0.5)",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
  safelist: [
    {
      pattern: /^(bg|text|border)-(brand|tremor)-.+/,
    },
  ],
};
