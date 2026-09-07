/** Kinetic Noir — dark-mode-first premium command center.
 *  4px spacing grid · Inter · #FFCC00 gold accent · charcoal surfaces */
export default {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-inter)', 'Inter', 'system-ui', 'sans-serif'],
      },
      colors: {
        noir: {
          950: '#07070a',
          900: '#0c0c10',
          850: '#111116',
          800: '#16161c',
          750: '#1c1c24',
          700: '#23232c',
          650: '#2a2a35',
          600: '#333340',
          500: '#3d3d4d',
          400: '#50506a',
          300: '#6b6b8a',
          200: '#8d8db0',
          100: '#b0b0cc',
          50: '#d0d0e0',
        },
        gold: {
          DEFAULT: '#FFCC00',
          50: '#FFF9E5',
          100: '#FFF3CC',
          200: '#FFE799',
          300: '#FFDB66',
          400: '#FFD133',
          500: '#FFCC00',
          600: '#E6B800',
          700: '#CCA300',
          800: '#997A00',
          900: '#665200',
        },
        accent: {
          success: '#34D399',
          warning: '#FBBF24',
          danger: '#F87171',
          info: '#60A5FA',
        },
      },
      borderRadius: {
        sm: '0.25rem',
        md: '0.375rem',
        lg: '0.5rem',
        xl: '0.75rem',
        '2xl': '1rem',
      },
      boxShadow: {
        glow: '0 0 20px rgba(255, 204, 0, 0.15)',
        'glow-lg': '0 0 40px rgba(255, 204, 0, 0.2)',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'fade-in': 'fadeIn 0.3s ease-out',
        'slide-up': 'slideUp 0.3s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
};
