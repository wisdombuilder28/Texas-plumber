# N.D. Flow Gallery Categories Update

This version adds a dynamic gallery category-management system without migrating the existing Firebase image storage approach.

## What changed

- Admin can create, rename, and delete gallery categories.
- `Completed` and `Still working` are seeded automatically if missing.
- Admin chooses a category during photo staging/upload.
- Existing photos can be reassigned from their category dropdown.
- Admin media library can be filtered by category.
- Category filters show item counts.
- Public `Recent Work` filters are generated from the same Firestore `categories` collection.
- Renaming a category changes the label everywhere without changing existing gallery records.
- Existing gallery documents that only have the old `category` field remain compatible.
- New gallery documents store both `categoryId` and `category` for backwards compatibility.
- Gallery caption security rule is aligned to the current 300-character UI limit.

## Firebase action required

Publish the updated `firestore.rules` in the Firebase Console.

No manual category collection setup is required. Open the admin Gallery page once while signed in as an authorised admin and the default categories will be created automatically if they are missing.

## Existing data behavior

Existing images with `category: "completed"` or `category: "in-progress"` continue to work. Existing images with no recognised category fall back to `Completed` until they are reassigned.

## Files changed

- `admin/gallery.html`
- `admin/js/gallery.js`
- `admin/admin.css`
- `work.html`
- `work-live.js`
- `firestore.rules`
- `FIREBASE_SETUP.md`
