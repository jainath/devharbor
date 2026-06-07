import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: ['./src/renderer/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          'SF Pro Text',
          'system-ui',
          'sans-serif'
        ],
        mono: [
          'SF Mono',
          'JetBrains Mono',
          'ui-monospace',
          'Menlo',
          'monospace'
        ]
      },
      colors: {
        // Semantic tokens driven by CSS variables in styles.css.
        // Both `.dark` and `.light` set their values; flipping the class on
        // <html> swaps the whole palette without per-component overrides.
        base: 'rgb(var(--bg-base) / <alpha-value>)',
        surface: 'rgb(var(--bg-surface) / <alpha-value>)',
        elevated: 'rgb(var(--bg-elevated) / <alpha-value>)',
        border: 'rgb(var(--border) / <alpha-value>)',
        'border-strong': 'rgb(var(--border-strong) / <alpha-value>)',
        fg: 'rgb(var(--fg) / <alpha-value>)',
        'fg-muted': 'rgb(var(--fg-muted) / <alpha-value>)',
        'fg-subtle': 'rgb(var(--fg-subtle) / <alpha-value>)',
        accent: {
          DEFAULT: 'rgb(var(--accent) / <alpha-value>)',
          fg: 'rgb(var(--accent-fg) / <alpha-value>)'
        },
        danger: {
          bg: 'rgb(var(--danger-bg) / <alpha-value>)',
          'bg-hover': 'rgb(var(--danger-bg-hover) / <alpha-value>)',
          fg: 'rgb(var(--danger-fg) / <alpha-value>)',
          border: 'rgb(var(--danger-border) / <alpha-value>)',
          strong: 'rgb(var(--danger-strong) / <alpha-value>)'
        },
        success: {
          bg: 'rgb(var(--success-bg) / <alpha-value>)',
          'bg-hover': 'rgb(var(--success-bg-hover) / <alpha-value>)',
          fg: 'rgb(var(--success-fg) / <alpha-value>)',
          border: 'rgb(var(--success-border) / <alpha-value>)',
          strong: 'rgb(var(--success-strong) / <alpha-value>)'
        },
        warn: {
          bg: 'rgb(var(--warn-bg) / <alpha-value>)',
          'bg-hover': 'rgb(var(--warn-bg-hover) / <alpha-value>)',
          fg: 'rgb(var(--warn-fg) / <alpha-value>)',
          border: 'rgb(var(--warn-border) / <alpha-value>)',
          strong: 'rgb(var(--warn-strong) / <alpha-value>)'
        }
      }
    }
  },
  plugins: []
};

export default config;
