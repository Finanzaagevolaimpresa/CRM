import type { Config } from 'tailwindcss';
import legacyColors from './config/tailwind-v3-colors.json';
const config: Config = { content: [], theme: { extend: { colors: { ...legacyColors, fai: { blue: '#043E8A', navy: '#052E70', green: '#00683E', lime: '#80CC2A', teal: '#008A6A', orange: '#F68612', purple: '#3D2974', gray: '#4B5563', bg: '#F4F7FB' } } } }, plugins: [] };
export default config;
