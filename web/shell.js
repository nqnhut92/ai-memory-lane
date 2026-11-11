import { createThemeController, paintThemeButton } from './theme-controller.js';
const button = document.querySelector('.local-theme');
const theme = createThemeController({ storageKey: 'memory-lane-theme', onChange: state => paintThemeButton(button, state) });
button.addEventListener('click', () => theme.cycle());
