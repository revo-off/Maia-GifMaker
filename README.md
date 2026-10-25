# Maia GifMaker

Incrustation d'images, vidéos, GIFs ou texte dans l'écran vert d'un GIF, puis export en GIF.

## Avant chaque build / push

```
npm run check        # ou : node tools/check.js
```

Le script régénère `gifs/catalog.json`, analyse chaque GIF (taille, durée, suivi et détourage de l'écran vert),
vérifie les fichiers du projet et affiche un topo. Les aperçus visuels sont dans `tools/reports/`
(ligne 1 : détourage sur damier, ligne 2 : rectangle suivi). Il retourne une erreur (code 1) si quelque chose est cassé.

## Ajouter un GIF

1. Déposer `gs<Nom>.gif` (fond vert) dans `gifs/`, et `<Nom>.gif` (écran transparent) si disponible.
2. `npm run check`. Si besoin, forcer `"chroma"` / `"tolerance"` dans l'entrée de `gifs/catalog.json`.

## Ajouter un template ou une police de texte

`texts/templates.json` et `texts/fonts.json` (police Google : `"google"`, fichier local : `"file": "texts/fonts/X.ttf"`).

## Structure

```
index.html
src/js/    app.js (application), keying.js (détourage + suivi), palette.js (palette d'export), text-editor.js
src/css/   style.css
gifs/      GIFs + catalog.json
texts/     templates.json, fonts.json, fonts/
tools/     check.js (vérification), build-catalog.js, reports/ (généré, ignoré par git)
lib/       bibliothèques tierces (gif.js, gifuct-js)
misc/      icône et curseurs
```
