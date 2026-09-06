const fs = require('fs');
const path = require('path');

// Icon sizes needed
const sizes = [72, 96, 128, 144, 152, 192, 384, 512];

// Brand blue used across logo.svg / favicon.svg
const BRAND_BLUE = 'hsl(221.2 83.2% 53.3%)';

// SVG template: full-bleed square background + centered lucide MessageSquare
// (same design as favicon.svg, which is the canonical source).
function createIconSVG(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}">
  <rect x="0" y="0" width="64" height="64" fill="${BRAND_BLUE}"/>
  <g transform="translate(32, 32) scale(1.333) translate(-12, -12)" stroke="white" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
  </g>
</svg>`;
}

// Generate SVG files for each size
sizes.forEach(size => {
  const svgContent = createIconSVG(size);
  const filename = `icon-${size}x${size}.svg`;
  const filepath = path.join(__dirname, 'icons', filename);

  fs.writeFileSync(filepath, svgContent);
  console.log(`Created ${filename}`);
});

console.log('\nSVG icons created! Convert to PNG with rsvg-convert:');
console.log('for s in 72 96 128 144 152 192 384 512; do rsvg-convert -w $s -h $s favicon.svg -o icons/icon-${s}x${s}.png; done');
