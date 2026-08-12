-- 000-create-database.sql
-- Creates the DWO database if it does not already exist.
--
-- 001-schema0726.sql opens with "USE [DWO]", so the database must exist before
-- it runs. On a shared/corporate server this script is a no-op: DWO is already
-- there and we never touch it. It only matters for a fresh local container.

IF DB_ID(N'DWO') IS NULL
BEGIN
    PRINT 'Creating database DWO...';
    CREATE DATABASE [DWO];
END
ELSE
BEGIN
    PRINT 'Database DWO already exists - leaving it alone.';
END
GO
