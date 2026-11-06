-- P0-WP11: services run as an application role that does not own the tables (grantAppRole).
-- Creating a partition requires owning audit_event, so the partition helper runs with its
-- owner's rights. It only creates the named month's partition; search_path is pinned.
ALTER FUNCTION adlc_ensure_audit_partition(date) SECURITY DEFINER SET search_path = public, pg_temp;
