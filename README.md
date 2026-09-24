# Читалка

Mobile-first PWA для локального чтения EPUB, FB2, TXT и PDF. Файлы, прогресс и настройки хранятся только в IndexedDB браузера.

## Возможности

- импорт EPUB / FB2 / TXT / PDF;
- метаданные и обложки, где формат их предоставляет;
- EPUB через `epubjs`, PDF через `pdfjs-dist`;
- FB2 через `DOMParser`, включая обложку из `<binary>`;
- TXT с UTF-8 → Windows-1251 fallback;
- локальная библиотека, удаление, сохранение позиции;
- темы, типографика и mobile-first интерфейс;
- PWA / offline precache через `vite-plugin-pwa`;
- иконки генерируются из `public/logo.svg` командой `@vite-pwa/assets-generator`.

## Локальный запуск

```bash
npm install
npm run dev
```

## Production build

```bash
npm run build
```

Перед build автоматически генерируются PWA-иконки из SVG.
