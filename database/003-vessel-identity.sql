-- 003-vessel-identity.sql
-- =========================================================================
-- Widens Vessel.Notes and records the rest of a vessel's AIS identity.
--
-- WHY THIS FILE EXISTS
--   Charlie 3's identity was confirmed against public trackers on 2026-07-29
--   (MMSI 341930000, IMO 9889928, call sign V4DX4, flag St Kitts & Nevis, real
--   particulars 42 x 7 m). data/vessels.json carries all of it; dbo.Vessel had
--   nowhere to put three of those five fields, and its Notes column was too
--   narrow to hold the evidence explaining them:
--
--     * Notes was varchar(1000). The CH3 note that records how the identity was
--       confirmed is 1156 characters, so re-running the importer failed with
--       "String or binary data would be truncated" - the note is the audit
--       trail for a disputed hull, so truncating it is the wrong trade.
--       nvarchar(max) is what every other long free-text column in 002 uses
--       (VesselDailyReport.IssuesComments, MovementPlanSnapshot.Notes, ...).
--
--     * IMO / CallSign / Flag had no columns at all. MMSI alone does not settle
--       an identity: MMSI is reassigned when a ship changes flag, while the IMO
--       number is hull-for-life. Storing both is what makes a future "is this
--       still the same ship?" answerable from the database.
--
-- RULES THIS FILE FOLLOWS
--   Additive, and only against our own 002 tables - it never touches
--   001-schema0726.sql. Every statement is guarded, so the script is
--   re-runnable even though migrate.sh journals it and will not repeat it.
-- =========================================================================

USE [DWO];
GO

SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO

-- -------------------------------------------------------------------------
-- Vessel.Notes -> nvarchar(max)
--
-- Guarded on the column's actual type rather than on a version number, so the
-- script is a no-op on a database that already has it. max_length = -1 is how
-- sys.columns spells "(max)".
-- -------------------------------------------------------------------------
IF EXISTS (
    SELECT 1
    FROM sys.columns c
    JOIN sys.types t ON t.user_type_id = c.user_type_id
    WHERE c.object_id = OBJECT_ID(N'[dbo].[Vessel]')
      AND c.name = N'Notes'
      AND NOT (t.name = N'nvarchar' AND c.max_length = -1))
BEGIN
    ALTER TABLE [dbo].[Vessel] ALTER COLUMN [Notes] [nvarchar](max) NULL;
END
GO

-- -------------------------------------------------------------------------
-- Vessel identity columns.
--
-- All nullable: only Charlie 3 has been researched to this depth so far, and a
-- guessed IMO is worse than a NULL one.
-- -------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.columns
               WHERE object_id = OBJECT_ID(N'[dbo].[Vessel]') AND name = N'IMO')
    ALTER TABLE [dbo].[Vessel] ADD [IMO] [varchar](20) NULL;   -- hull-for-life, unlike MMSI
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns
               WHERE object_id = OBJECT_ID(N'[dbo].[Vessel]') AND name = N'CallSign')
    ALTER TABLE [dbo].[Vessel] ADD [CallSign] [varchar](20) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns
               WHERE object_id = OBJECT_ID(N'[dbo].[Vessel]') AND name = N'Flag')
    ALTER TABLE [dbo].[Vessel] ADD [Flag] [varchar](100) NULL;  -- 'St Kitts & Nevis'
GO
