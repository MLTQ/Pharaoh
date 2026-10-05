# RvcCard.tsx

## Purpose
Settings card for the RVC (voice lock) server's URL.

## Components

### `RvcCard`
- **Does**: In split-servers mode, a URL field for the RVC server (:18006), saved on blur. Renders nothing in unified mode, where the URL is derived from the inference host.

### `UrlCard`
- **Does**: A server card carrying only a URL field.
