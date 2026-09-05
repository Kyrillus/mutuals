-- Drops `import_row_detail_needs_a_pointer`, added one migration ago, because it conflicts with a
-- constraint that has been there since 0005 and breaks an ordinary operation.
--
-- `import_row.duplicate_of` references `record` with ON DELETE SET NULL. So deleting a contact that
-- some lingering import batch flagged a row against nulls that pointer -- and the CHECK then refuses
-- the write, because `duplicate_detail` is still set. The failure surfaces as a contact that cannot
-- be deleted, with a message naming a table the user has never heard of, for a batch they abandoned
-- last week. Found by deleting the records a test import had created.
--
-- The check was tidiness, not an invariant: it said "no explanation without something to explain".
-- Being wrong in that direction is harmless -- a detail whose pointer has gone is an orphan the
-- reader ignores -- while being wrong in the other direction blocks a delete. `toRowDto` in
-- `apps/api` only renders a duplicate when a pointer is actually present, so an orphaned detail
-- shows nothing rather than a chip pointing nowhere.
--
-- The two checks that carry real weight stay: at most one pointer kind, and a row pointer that
-- always points backwards so a chain has a first element (ADR-097).

ALTER TABLE import_row DROP CONSTRAINT import_row_detail_needs_a_pointer;
