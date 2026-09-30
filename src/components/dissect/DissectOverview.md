# DissectOverview.tsx

## Purpose
The whole recording on one canvas: chapter bands, up to five voice lanes, and effect / ambience / music lanes, with a hover readout of time and chapter.

## Notes
- Canvas, not DOM: a 20 h book has tens of thousands of turns. Turns falling on the same pixel column are merged while drawing.
- Colours come from the theme's CSS variables so it follows the colour temperature setting.
