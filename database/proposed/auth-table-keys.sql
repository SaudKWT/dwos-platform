/* ---------------------------------------------------------------------------
 * PROPOSED — for the KOC DBA. NOT APPLIED BY migrate.sh.
 *
 * This file sits in database/proposed/ deliberately. `migrate.sh` globs
 * `database/[0-9][0-9][0-9]-*.sql` at the top level only, so nothing here runs
 * automatically and nothing here is journalled in dbo.SchemaVersions.
 *
 * WHY IT IS NOT A NORMAL MIGRATION
 * --------------------------------
 * Every table below comes from 001-schema0726.sql, the corporate schema. The
 * rule in this repository, stated in 002-marine-tables.sql, database/README.md
 * and docs/HANDOFF.md, is that those 43 tables are read-only: additive scripts
 * never ALTER or DROP one, because the schema may be shared with other KOC
 * systems. Adding a primary key is an ALTER, and a clustered one changes how the
 * table is physically stored. That is the DBA's decision, not ours to make in a
 * migration that runs unattended.
 *
 * THE PROBLEM
 * -----------
 * These five are the ONLY tables of the 43 with no primary key, no unique
 * constraint and no index of any kind:
 *
 *     Privilege · Role · RolePrivilege · UserPrivilege · UserRole
 *
 * Every other table has one — PK_Well, PK_Drilling, PK_Workover and so on. And
 * these five are the authorization tables: once authentication is switched on,
 * every module hits them on every request, to resolve which user holds which
 * privilege through which role. They are simultaneously the least-constrained
 * and most-read part of the database.
 *
 * Today that costs nothing, because they are empty. It becomes a table scan per
 * request per module as soon as they are not, and by then the fix means taking
 * locks on tables the whole platform depends on.
 *
 * WHAT THIS DOES
 * --------------
 *   - a clustered primary key on each ID column (all five are int IDENTITY
 *     NOT NULL already, so no data can violate it)
 *   - nonclustered indexes on the columns a permission check actually filters
 *     and joins on
 *   - nothing else: no column added, dropped, renamed or retyped, no data
 *     touched, no FK created
 *
 * Foreign keys are deliberately NOT proposed here. RolePrivilege.RoleID and
 * friends are nullable and unconstrained, and adding referential integrity to a
 * shared table is a bigger conversation than adding an index — worth having,
 * separately.
 *
 * VERIFIED
 * --------
 * Applies clean and is re-runnable, tested 2026-08-12 against a fresh DWO built
 * from 000..004 on SQL Server 2022. It is guarded throughout, so running it
 * twice is a no-op.
 *
 * Run:  sqlcmd -d DWO -i database/proposed/auth-table-keys.sql
 * --------------------------------------------------------------------------- */

USE [DWO];
GO

SET NOCOUNT ON;
GO

/* -- Primary keys ---------------------------------------------------------- */

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = N'PK_Privilege')
    ALTER TABLE [dbo].[Privilege] ADD CONSTRAINT [PK_Privilege] PRIMARY KEY CLUSTERED ([ID] ASC);
GO
IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = N'PK_Role')
    ALTER TABLE [dbo].[Role] ADD CONSTRAINT [PK_Role] PRIMARY KEY CLUSTERED ([ID] ASC);
GO
IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = N'PK_RolePrivilege')
    ALTER TABLE [dbo].[RolePrivilege] ADD CONSTRAINT [PK_RolePrivilege] PRIMARY KEY CLUSTERED ([ID] ASC);
GO
IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = N'PK_UserPrivilege')
    ALTER TABLE [dbo].[UserPrivilege] ADD CONSTRAINT [PK_UserPrivilege] PRIMARY KEY CLUSTERED ([ID] ASC);
GO
IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = N'PK_UserRole')
    ALTER TABLE [dbo].[UserRole] ADD CONSTRAINT [PK_UserRole] PRIMARY KEY CLUSTERED ([ID] ASC);
GO

/* -- Lookup indexes --------------------------------------------------------
 * Shaped to the two questions a permission check asks:
 *   "what may this user do"    User -> UserRole -> RolePrivilege -> Privilege
 *                              User -> UserPrivilege -> Privilege
 *   "who may do this"          the same joins, read the other way
 * INCLUDE carries the join's other column so the lookup is covering.
 */

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_UserRole_UserID')
    CREATE NONCLUSTERED INDEX [IX_UserRole_UserID] ON [dbo].[UserRole] ([UserID] ASC) INCLUDE ([RoleID], [StartDate], [EndDate]);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_UserRole_RoleID')
    CREATE NONCLUSTERED INDEX [IX_UserRole_RoleID] ON [dbo].[UserRole] ([RoleID] ASC) INCLUDE ([UserID]);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_RolePrivilege_RoleID')
    CREATE NONCLUSTERED INDEX [IX_RolePrivilege_RoleID] ON [dbo].[RolePrivilege] ([RoleID] ASC) INCLUDE ([PrivilegeID]);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_RolePrivilege_PrivilegeID')
    CREATE NONCLUSTERED INDEX [IX_RolePrivilege_PrivilegeID] ON [dbo].[RolePrivilege] ([PrivilegeID] ASC) INCLUDE ([RoleID]);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_UserPrivilege_UserID')
    CREATE NONCLUSTERED INDEX [IX_UserPrivilege_UserID] ON [dbo].[UserPrivilege] ([UserID] ASC) INCLUDE ([PrivilegeID], [StartDate], [EndDate]);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_UserPrivilege_PrivilegeID')
    CREATE NONCLUSTERED INDEX [IX_UserPrivilege_PrivilegeID] ON [dbo].[UserPrivilege] ([PrivilegeID] ASC) INCLUDE ([UserID]);
GO

/* The privilege tree is walked by parent — dbo.Privilege.PrivilegeParentId is
 * self-referencing, and 004-register-modules.sql creates one parent per module
 * with a child per action. */
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Privilege_ParentId')
    CREATE NONCLUSTERED INDEX [IX_Privilege_ParentId] ON [dbo].[Privilege] ([PrivilegeParentId] ASC) INCLUDE ([PrivilegeName], [IsActive]);
GO

/* Both are looked up by name — 004 locates rows that way precisely because there
 * is no unique constraint to key on. Not declared UNIQUE here: nothing in the
 * corporate schema guarantees the names are distinct, and a unique index that
 * fails on real data at KOC would be a worse outcome than a duplicate. */
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Privilege_Name')
    CREATE NONCLUSTERED INDEX [IX_Privilege_Name] ON [dbo].[Privilege] ([PrivilegeName] ASC);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Role_Name')
    CREATE NONCLUSTERED INDEX [IX_Role_Name] ON [dbo].[Role] ([RoleName] ASC);
GO

PRINT 'Auth tables — keys and indexes:';
GO
SELECT  t.name AS TableName,
        ISNULL(k.name, '(none)') AS PrimaryKey,
        (SELECT COUNT(*) FROM sys.indexes i WHERE i.object_id = t.object_id AND i.type_desc = 'NONCLUSTERED') AS Indexes
FROM sys.tables t
LEFT JOIN sys.key_constraints k ON k.parent_object_id = t.object_id AND k.type = 'PK'
WHERE t.name IN ('Privilege','Role','RolePrivilege','UserPrivilege','UserRole')
ORDER BY t.name;
GO
