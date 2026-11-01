# MorvehTV Admin

Panel de administración de [MorvehTV](https://morvehtv.es): catálogo, añadir títulos desde TMDB, subir vídeos a IDrive e2 y **avisos de contenido nuevo en Telegram** (también en grupos con temas).

Es una web estática (HTML, CSS y JS sin compilar) que se conecta al servidor de MorvehTV. Para entrar hace falta la clave de administración (`ADMIN_KEY`).

## Archivos

| Archivo | Qué es |
|---|---|
| `index.html` | El panel |
| `js/config.js` | Dirección del servidor (`https://morvehtv.es`). Cámbiala aquí si mueves la API |
| `js/admin.js`, `js/api.js` | Lógica del panel y cliente de la API |
| `css/` | Estilos |

## Usarlo

- **En línea:** activa GitHub Pages (Settings → Pages → Deploy from a branch → `main` / root) y el panel queda en `https://saitamaeditor.github.io/telegrampaneloficial/`.
- **En tu PC:** abre una terminal en esta carpeta y ejecuta `python -m http.server 8080`; luego entra en http://localhost:8080.
- El mismo panel también está siempre en https://morvehtv.es/admin.

## Notificaciones de Telegram

En la sección **Notificaciones**:

1. Crea un bot con **@BotFather** (`/newbot`) y pega su token.
2. Añade el bot a tu grupo, escribe un mensaje allí y pulsa **Buscar grupos** → **Usar este**.
3. Si el grupo tiene temas, elige el tema de **🎬 Películas**, **📺 Series**, **🎥 Documentales** y **🎞 Docuseries**, o pulsa **Crear los temas que faltan** (el bot debe ser administrador con permiso para gestionar temas).
4. **Enviar mensaje de prueba** para comprobarlo.

A partir de ahí, cada película o episodio nuevo que se pueda ver se publica en el grupo con su cartel y un botón «▶ Ver en MorvehTV».

El código del servidor, la web y la app está en [saitamaeditor/fotograma](https://github.com/saitamaeditor/fotograma); este repositorio es una copia del panel (`web/admin.html` y sus archivos).
