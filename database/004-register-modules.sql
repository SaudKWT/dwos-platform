/* ---------------------------------------------------------------------------
 * 004 — Register the platform's modules in the corporate registry.
 *
 * WHY THIS EXISTS
 * ---------------
 * 002 added twelve marine tables and never registered the app it belongs to.
 * That is not cosmetic. `dbo.Log` declares:
 *
 *     [ModuleID] [int] NOT NULL
 *
 * so with no Module row the vessel app cannot write a single audit entry — not
 * "once authentication is switched on", but at all, today, at the database
 * level. Every module added after this one inherits the same requirement.
 *
 * `dbo.Module` is also what drives the menu (`dbo.Form` hangs off ModuleID) and
 * what partitions the status vocabulary (`dbo.Status.ModuleID`, one of only
 * seven declared foreign keys in the whole 43-table corporate schema). So
 * registering a module is four related inserts, not one:
 *
 *     Privilege  →  Module  →  Form (one per screen)  →  Status (its vocabulary)
 *
 * NO HARDCODED IDs
 * ----------------
 * Every table in 001 keys on [ID] int IDENTITY and 001 declares no UNIQUE
 * constraint anywhere, so IDs differ between any two DWO databases and names
 * are not guaranteed distinct either. Nothing below assumes an ID. Rows are
 * located by name and created only when absent, which also makes the script
 * re-runnable — the same guard style 002 and 003 use.
 *
 * WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
 * -----------------------------------------
 * It grants nothing to anyone. RolePrivilege and UserPrivilege stay empty:
 * who may see the vessel app is a KOC access decision, not a migration. The
 * privileges exist so that decision has something to point at.
 * --------------------------------------------------------------------------- */

USE [DWO];
GO

SET NOCOUNT ON;
GO

/* -- Privileges -------------------------------------------------------------
 * A parent per module, one child per action. dbo.Privilege is a tree
 * (PrivilegeParentId) with no ModuleID: authorization is global and the binding
 * runs the other way — the menu node names the privilege that gates it.
 */
DECLARE @privRoot int;

IF NOT EXISTS (SELECT 1 FROM dbo.Privilege WHERE PrivilegeName = N'Vessel Movement')
    INSERT INTO dbo.Privilege (PrivilegeName, PrivilegeParentId, Remarks, IsActive)
    VALUES (N'Vessel Movement', NULL,
            N'Offshore unit marine logistics. Parent of the vessel-movement actions.', 1);

SELECT TOP 1 @privRoot = ID FROM dbo.Privilege WHERE PrivilegeName = N'Vessel Movement' ORDER BY ID;

IF NOT EXISTS (SELECT 1 FROM dbo.Privilege WHERE PrivilegeName = N'Vessel Movement — View')
    INSERT INTO dbo.Privilege (PrivilegeName, PrivilegeParentId, Remarks, IsActive)
    VALUES (N'Vessel Movement — View', @privRoot, N'Read the fleet, reports and plans.', 1);

IF NOT EXISTS (SELECT 1 FROM dbo.Privilege WHERE PrivilegeName = N'Vessel Movement — File report')
    INSERT INTO dbo.Privilege (PrivilegeName, PrivilegeParentId, Remarks, IsActive)
    VALUES (N'Vessel Movement — File report', @privRoot,
            N'Submit a Daily Vessel Report. Held by masters and by the marine supervisor.', 1);

IF NOT EXISTS (SELECT 1 FROM dbo.Privilege WHERE PrivilegeName = N'Vessel Movement — Issue plan')
    INSERT INTO dbo.Privilege (PrivilegeName, PrivilegeParentId, Remarks, IsActive)
    VALUES (N'Vessel Movement — Issue plan', @privRoot,
            N'Issue the 48-hour movement plan. Supervisor only.', 1);
GO

/* -- Module -----------------------------------------------------------------
 * ParentModuleID stays NULL: this is a root node. If DWO later grows a parent
 * node per team or unit, re-point it here rather than duplicating the module.
 */
DECLARE @privView int, @moduleId int;
SELECT TOP 1 @privView = ID FROM dbo.Privilege WHERE PrivilegeName = N'Vessel Movement — View' ORDER BY ID;

IF NOT EXISTS (SELECT 1 FROM dbo.Module WHERE ModuleName = N'Vessel Movement')
    INSERT INTO dbo.Module (ModuleName, Description, ParentModuleID, DisplayOrder, PrivilegeID, IsAttachedToMenu, IsActive)
    VALUES (N'Vessel Movement',
            N'Offshore marine logistics: fleet position, daily vessel reports and the 48-hour movement plan.',
            NULL, 10, @privView, 1, 1);

SELECT TOP 1 @moduleId = ID FROM dbo.Module WHERE ModuleName = N'Vessel Movement' ORDER BY ID;

/* -- Forms — one per screen, in nav order ---------------------------------- */
DECLARE @forms TABLE (FormName nvarchar(100), Descr nvarchar(255), Ord int, Priv nvarchar(255));
INSERT INTO @forms (FormName, Descr, Ord, Priv) VALUES
    (N'Fleet map',            N'Live and replayed vessel positions.',                    10, N'Vessel Movement — View'),
    (N'Daily vessel reports', N'One report per vessel per day, imported or filed.',       20, N'Vessel Movement — View'),
    (N'File a report',        N'The Daily Vessel Report form.',                           30, N'Vessel Movement — File report'),
    (N'48-hr movement plan',  N'The supervisor''s forward plan.',                         40, N'Vessel Movement — Issue plan');

INSERT INTO dbo.Form (FormName, Description, ModuleID, ParentFormID, DisplayOrder, PrivilegeID, IsActive)
SELECT f.FormName, f.Descr, @moduleId, NULL, f.Ord,
       (SELECT TOP 1 p.ID FROM dbo.Privilege p WHERE p.PrivilegeName = f.Priv ORDER BY p.ID), 1
FROM @forms f
WHERE NOT EXISTS (
    SELECT 1 FROM dbo.Form ex WHERE ex.FormName = f.FormName AND ex.ModuleID = @moduleId
);

/* -- Status vocabulary ------------------------------------------------------
 * dbo.Status is partitioned by ModuleID, so these names cannot collide with
 * another module's. Note the partition is advisory: every consuming column is a
 * plain int with no foreign key, so nothing at the database level stops one
 * module's row taking another module's status. Enforce it in the API.
 */
DECLARE @statuses TABLE (Nm nvarchar(50), Descr nvarchar(255), Ord int, Cat nvarchar(50));
INSERT INTO @statuses (Nm, Descr, Ord, Cat) VALUES
    (N'Draft',     N'Started, not submitted.',                     10, N'Report'),
    (N'Submitted', N'Filed by the master.',                        20, N'Report'),
    (N'Imported',  N'Parsed from an emailed PDF rather than filed.',30, N'Report'),
    (N'Superseded',N'Replaced by a later submission for the same vessel and date.', 40, N'Report');

INSERT INTO dbo.Status (ModuleID, Status, Description, IsActive, DisplayOrder, StatusCategory)
SELECT @moduleId, s.Nm, s.Descr, 1, s.Ord, s.Cat
FROM @statuses s
WHERE NOT EXISTS (
    SELECT 1 FROM dbo.Status ex WHERE ex.ModuleID = @moduleId AND ex.Status = s.Nm
);
GO

PRINT 'Module registry:';
GO
SELECT  m.ID AS ModuleID, m.ModuleName,
        (SELECT COUNT(*) FROM dbo.Form  f WHERE f.ModuleID = m.ID) AS Forms,
        (SELECT COUNT(*) FROM dbo.Status s WHERE s.ModuleID = m.ID) AS Statuses
FROM dbo.Module m
ORDER BY m.DisplayOrder, m.ID;
GO
