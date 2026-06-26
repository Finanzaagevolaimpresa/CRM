import type { Config } from 'tailwindcss';
const config: Config = { content: ['./src/**/*.{ts,tsx}'], theme: { extend: { colors: { fai: { blue: '#043E8A', navy: '#052E70', green: '#00683E', lime: '#80CC2A', orange: '#F68612', gray: '#4B5563', bg: '#F4F7FB' } } } }, plugins: [] };
export default config;
