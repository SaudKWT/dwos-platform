-- 002-marine-tables.sql
-- =========================================================================
-- Vessel-movement tables for the DWO database.
--
-- WHY THIS FILE EXISTS
--   schema0726.sql is the corporate drilling schema (43 tables: users,
--   privileges, assets, wells, rigs, drilling, workover, budgets). It has no
--   concept of a vessel, a movement plan, a daily vessel report or an AIS
--   position. Everything the vessel-movement app needs is created here.
--
-- RULES THIS FILE FOLLOWS
--   * Additive only. It never ALTERs or DROPs a table from 001-schema0726.sql.
--     That schema is treated as read-only because it may be shared with other
--     corporate systems.
--   * Foreign keys point INTO the legacy schema (e.g. MarineLocation.RigID ->
--     dbo.Rig) but never constrain it. Legacy tables ship without FKs and
--     adding any could break another system's inserts.
--   * House style is kept: dbo schema, [ID] int IDENTITY(1,1) primary key,
--     IsActive / IsDeleted bit flags with the same DEFAULT_<Table>_<Col>
--     constraint naming.
--   * Re-runnable: every object is guarded by an existence check.
--
-- TIME ZONES - read this before adding a datetime column
--   Vessel reports and movement plans are Kuwait local time (UTC+3). That is
--   the convention of the source PDFs, of every existing JSON file, and of the
--   legacy schema itself (dbo.Log.Timestamp defaults to getdate()+3h).
--   AIS positions are the exception: the feed is UTC, so those columns are
--   suffixed Utc. Never mix the two in one column.
-- =========================================================================

USE [DWO];
GO

SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO

-- -------------------------------------------------------------------------
-- MarineLocation - berths, ports and rigs the vessels move between.
-- Replaces data/locations.json -> locations[].
-- RigID optionally ties a marine location to a real dbo.Rig row, so "Rig
-- Oriental Phoenix" on the map is the same rig the drilling system knows.
-- -------------------------------------------------------------------------
IF OBJECT_ID(N'[dbo].[MarineLocation]', N'U') IS NULL
BEGIN
CREATE TABLE [dbo].[MarineLocation](
    [ID]           [int] IDENTITY(1,1) NOT NULL,
    [LocationCode] [varchar](20)  NOT NULL,   -- B4, B20, NP, OPH, OD
    [LocationName] [varchar](255) NOT NULL,   -- 'Shuaiba Port - Berth 4'
    [ShortName]    [varchar](50)  NULL,       -- map label
    [Latitude]     [decimal](10, 7) NOT NULL,
    [Longitude]    [decimal](10, 7) NOT NULL,
    [LocationType] [varchar](20)  NOT NULL,   -- berth | port | rig | anchorage | waypoint
    [BerthUse]     [varchar](255) NULL,       -- 'PSV (Crest Argus 1/3/5)'
    [RigID]        [int]          NULL,       -- -> dbo.Rig (legacy, nullable)
    [IsActive]     [bit] NOT NULL,
    [IsDeleted]    [bit] NOT NULL,
 CONSTRAINT [PK_MarineLocation] PRIMARY KEY CLUSTERED ([ID] ASC)
     WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF,
           ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY];
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = N'DEFAULT_MarineLocation_IsActive')
    ALTER TABLE [dbo].[MarineLocation] ADD CONSTRAINT [DEFAULT_MarineLocation_IsActive] DEFAULT ((1)) FOR [IsActive];
GO
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = N'DEFAULT_MarineLocation_IsDeleted')
    ALTER TABLE [dbo].[MarineLocation] ADD CONSTRAINT [DEFAULT_MarineLocation_IsDeleted] DEFAULT ((0)) FOR [IsDeleted];
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UQ_MarineLocation_LocationCode' AND object_id = OBJECT_ID(N'[dbo].[MarineLocation]'))
    CREATE UNIQUE NONCLUSTERED INDEX [UQ_MarineLocation_LocationCode] ON [dbo].[MarineLocation]([LocationCode] ASC);
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_MarineLocation_Rig')
    ALTER TABLE [dbo].[MarineLocation] WITH NOCHECK
        ADD CONSTRAINT [FK_MarineLocation_Rig] FOREIGN KEY([RigID]) REFERENCES [dbo].[Rig] ([ID]);
GO

-- -------------------------------------------------------------------------
-- MarineLocationAlias - the many spellings the source PDFs/emails use.
-- Replaces data/locations.json -> aliases{}. The PDF importer resolves
-- free text ('Rig Oriental Phoenix', 'OPH', 'NSBP') to a location through here.
--
-- MarineLocationID is NULLABLE because not every alias names one place. A bare
-- "Shuaiba Port" means berth 4 to the crew boats and berth 20 to the PSVs -
-- the source JSON records that as the pseudo-target "B20_or_B4". Such an alias
-- gets a NULL location and a ResolutionHint telling the caller how to finish
-- the job. Pointing it at either berth would silently put vessels at the wrong
-- one for half the fleet.
-- -------------------------------------------------------------------------
IF OBJECT_ID(N'[dbo].[MarineLocationAlias]', N'U') IS NULL
BEGIN
CREATE TABLE [dbo].[MarineLocationAlias](
    [ID]               [int] IDENTITY(1,1) NOT NULL,
    [MarineLocationID] [int] NULL,                  -- NULL = ambiguous, see ResolutionHint
    [Alias]            [varchar](255) NOT NULL,
    [ResolutionHint]   [varchar](50)  NULL,         -- 'vessel_home_berth' when ambiguous
 CONSTRAINT [PK_MarineLocationAlias] PRIMARY KEY CLUSTERED ([ID] ASC)
     WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF,
           ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY];
END
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_MarineLocationAlias_MarineLocation')
    ALTER TABLE [dbo].[MarineLocationAlias]
        ADD CONSTRAINT [FK_MarineLocationAlias_MarineLocation] FOREIGN KEY([MarineLocationID])
        REFERENCES [dbo].[MarineLocation] ([ID]);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UQ_MarineLocationAlias_Alias' AND object_id = OBJECT_ID(N'[dbo].[MarineLocationAlias]'))
    CREATE UNIQUE NONCLUSTERED INDEX [UQ_MarineLocationAlias_Alias] ON [dbo].[MarineLocationAlias]([Alias] ASC);
GO

-- -------------------------------------------------------------------------
-- Vessel - the fleet. Replaces data/vessels.json.
--
-- ActiveFrom / RetiredOn / ReplacedVesselID exist because Charlie 3 took over
-- Allianz Juno's role and berth on 2026-05-20. Without the retirement date the
-- app carries Juno's last position forward for ever and draws two vessels at
-- one berth. The dates are load-bearing, not documentation.
-- -------------------------------------------------------------------------
IF OBJECT_ID(N'[dbo].[Vessel]', N'U') IS NULL
BEGIN
CREATE TABLE [dbo].[Vessel](
    [ID]                 [int] IDENTITY(1,1) NOT NULL,
    [VesselCode]         [varchar](20)  NOT NULL,  -- JUNO, CH3, CA1, CA3, CA5
    [VesselName]         [varchar](150) NOT NULL,  -- 'Crest Argus 1'
    [VesselType]         [varchar](100) NULL,      -- 'PSV', 'SV - Fast Crew Boat'
    [LengthM]            [decimal](8, 2) NULL,
    [BeamM]              [decimal](8, 2) NULL,
    [SpeedKts]           [decimal](5, 2) NULL,
    [HomeBerthLocationID][int]           NULL,     -- -> dbo.MarineLocation
    [MMSI]               [varchar](20)  NULL,      -- AIS identity
    [MapColor]           [varchar](10)  NULL,      -- '#e0413f'
    [MapStroke]          [varchar](10)  NULL,
    [ContractorID]       [int]          NULL,      -- -> dbo.Contractor (legacy owner/charterer)
    [ActiveFrom]         [date]         NULL,      -- first day the vessel appears
    [RetiredOn]          [date]         NULL,      -- last day + 1; NULL = still in service
    [ReplacedVesselID]   [int]          NULL,      -- -> dbo.Vessel (self)
    [SpecsProvisional]   [bit]          NOT NULL,  -- 1 = dimensions are a stand-in
    [Notes]              [varchar](1000) NULL,
    [IsActive]           [bit] NOT NULL,
    [IsDeleted]          [bit] NOT NULL,
 CONSTRAINT [PK_Vessel] PRIMARY KEY CLUSTERED ([ID] ASC)
     WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF,
           ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY];
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = N'DEFAULT_Vessel_IsActive')
    ALTER TABLE [dbo].[Vessel] ADD CONSTRAINT [DEFAULT_Vessel_IsActive] DEFAULT ((1)) FOR [IsActive];
GO
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = N'DEFAULT_Vessel_IsDeleted')
    ALTER TABLE [dbo].[Vessel] ADD CONSTRAINT [DEFAULT_Vessel_IsDeleted] DEFAULT ((0)) FOR [IsDeleted];
GO
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = N'DEFAULT_Vessel_SpecsProvisional')
    ALTER TABLE [dbo].[Vessel] ADD CONSTRAINT [DEFAULT_Vessel_SpecsProvisional] DEFAULT ((0)) FOR [SpecsProvisional];
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UQ_Vessel_VesselCode' AND object_id = OBJECT_ID(N'[dbo].[Vessel]'))
    CREATE UNIQUE NONCLUSTERED INDEX [UQ_Vessel_VesselCode] ON [dbo].[Vessel]([VesselCode] ASC);
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_Vessel_HomeBerth')
    ALTER TABLE [dbo].[Vessel]
        ADD CONSTRAINT [FK_Vessel_HomeBerth] FOREIGN KEY([HomeBerthLocationID]) REFERENCES [dbo].[MarineLocation] ([ID]);
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_Vessel_ReplacedVessel')
    ALTER TABLE [dbo].[Vessel]
        ADD CONSTRAINT [FK_Vessel_ReplacedVessel] FOREIGN KEY([ReplacedVesselID]) REFERENCES [dbo].[Vessel] ([ID]);
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_Vessel_Contractor')
    ALTER TABLE [dbo].[Vessel] WITH NOCHECK
        ADD CONSTRAINT [FK_Vessel_Contractor] FOREIGN KEY([ContractorID]) REFERENCES [dbo].[Contractor] ([ID]);
GO

-- -------------------------------------------------------------------------
-- VesselDailyReport - the captain's midnight report. One per vessel per day.
-- Replaces data/daily-reports/<VESSEL>-<DATE>.json (256 files).
--
-- RawJson holds the complete original payload. The PDFs differ per vessel
-- (Juno reports 2 tanks, the Crest boats report mud/barite/cement and lifts),
-- so promoting every field to a column would mean a sparse table and a lossy
-- import. Columns exist for what we query and sort by; RawJson guarantees the
-- migration loses nothing and lets us promote more fields later without
-- re-importing from PDFs.
-- -------------------------------------------------------------------------
IF OBJECT_ID(N'[dbo].[VesselDailyReport]', N'U') IS NULL
BEGIN
CREATE TABLE [dbo].[VesselDailyReport](
    [ID]                 [int] IDENTITY(1,1) NOT NULL,
    [VesselID]           [int]  NOT NULL,
    [ReportDate]         [date] NOT NULL,          -- the 24h period covered (Kuwait local)
    [PeriodEnd]          [varchar](10) NULL,       -- '24:00'
    [VoyageNo]           [varchar](50) NULL,       -- '041/2026'
    [CompiledByName]     [varchar](150) NULL,      -- 'Capt. Ehab Elsayed Elmelegy Shehab'
    [CompiledByRole]     [varchar](50)  NULL,      -- 'Master'
    [SubmittedAt]        [datetime2](0) NULL,      -- Kuwait local
    [SafetyAccidents]    [varchar](500) NULL,      -- 'Nil'
    [SafetyIncidents]    [varchar](500) NULL,
    [SafetyNearMiss]     [varchar](500) NULL,
    [DaysSincePortCall]  [int] NULL,
    [SecurityLevel]      [int] NULL,
    [NextCrewChange]     [varchar](100) NULL,
    [IssuesComments]     [nvarchar](max) NULL,
    [AccidentSummary]    [nvarchar](max) NULL,
    -- provenance (source{} in the JSON)
    [SourceType]         [varchar](50)  NULL,      -- imported_email | dashboard_submission | imported_pdf
    [SourceEmailSubject] [varchar](500) NULL,
    [SourceEmailFrom]    [varchar](255) NULL,
    [SourceEmailDate]    [datetime2](0) NULL,
    [SourceAttachment]   [varchar](500) NULL,
    [SourceSubmittedVia] [varchar](100) NULL,
    [RawJson]            [nvarchar](max) NULL,     -- complete original payload
    [CreatedOn]          [datetime2](0) NOT NULL,
    [CreatedByUserID]    [int] NULL,               -- -> dbo.[User]
    [ModifiedOn]         [datetime2](0) NULL,
    [ModifiedByUserID]   [int] NULL,
    [IsDeleted]          [bit] NOT NULL,
 CONSTRAINT [PK_VesselDailyReport] PRIMARY KEY CLUSTERED ([ID] ASC)
     WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF,
           ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY];
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = N'DEFAULT_VesselDailyReport_IsDeleted')
    ALTER TABLE [dbo].[VesselDailyReport] ADD CONSTRAINT [DEFAULT_VesselDailyReport_IsDeleted] DEFAULT ((0)) FOR [IsDeleted];
GO
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = N'DEFAULT_VesselDailyReport_CreatedOn')
    ALTER TABLE [dbo].[VesselDailyReport] ADD CONSTRAINT [DEFAULT_VesselDailyReport_CreatedOn]
        DEFAULT (dateadd(hour,(3),getutcdate())) FOR [CreatedOn];
GO
-- One report per vessel per day is the domain rule; a re-submission overwrites.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UQ_VesselDailyReport_Vessel_Date' AND object_id = OBJECT_ID(N'[dbo].[VesselDailyReport]'))
    CREATE UNIQUE NONCLUSTERED INDEX [UQ_VesselDailyReport_Vessel_Date]
        ON [dbo].[VesselDailyReport]([VesselID] ASC, [ReportDate] ASC);
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_VesselDailyReport_Vessel')
    ALTER TABLE [dbo].[VesselDailyReport]
        ADD CONSTRAINT [FK_VesselDailyReport_Vessel] FOREIGN KEY([VesselID]) REFERENCES [dbo].[Vessel] ([ID]);
GO

-- -------------------------------------------------------------------------
-- VesselReportTask - the hour-by-hour task log (task_log[]).
-- ~4,835 rows across the 256 historical reports. This is what the simulator
-- replays to place a vessel on the map at a given minute.
-- -------------------------------------------------------------------------
IF OBJECT_ID(N'[dbo].[VesselReportTask]', N'U') IS NULL
BEGIN
CREATE TABLE [dbo].[VesselReportTask](
    [ID]                  [int] IDENTITY(1,1) NOT NULL,
    [VesselDailyReportID] [int] NOT NULL,
    [SortOrder]           [int] NOT NULL,
    [FromTime]            [varchar](10) NULL,       -- '00:00' (kept as text: '24:00' is valid here)
    [ToTime]              [varchar](10) NULL,       -- '24:00'
    [DurationMin]         [int] NULL,
    [TaskCode]            [varchar](50)  NULL,      -- 'S01/A01'
    [TaskLabel]           [varchar](255) NULL,      -- 'Standby on location / Standby at anchor'
    [Description]         [nvarchar](max) NULL,
    [LocationID]          [int] NULL,               -- where the task happened
    [FromLocationID]      [int] NULL,               -- set on passage rows
    [ToLocationID]        [int] NULL,
 CONSTRAINT [PK_VesselReportTask] PRIMARY KEY CLUSTERED ([ID] ASC)
     WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF,
           ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY];
END
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_VesselReportTask_Report')
    ALTER TABLE [dbo].[VesselReportTask]
        ADD CONSTRAINT [FK_VesselReportTask_Report] FOREIGN KEY([VesselDailyReportID])
        REFERENCES [dbo].[VesselDailyReport] ([ID]) ON DELETE CASCADE;
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_VesselReportTask_Location')
    ALTER TABLE [dbo].[VesselReportTask]
        ADD CONSTRAINT [FK_VesselReportTask_Location] FOREIGN KEY([LocationID]) REFERENCES [dbo].[MarineLocation] ([ID]);
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_VesselReportTask_FromLocation')
    ALTER TABLE [dbo].[VesselReportTask]
        ADD CONSTRAINT [FK_VesselReportTask_FromLocation] FOREIGN KEY([FromLocationID]) REFERENCES [dbo].[MarineLocation] ([ID]);
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_VesselReportTask_ToLocation')
    ALTER TABLE [dbo].[VesselReportTask]
        ADD CONSTRAINT [FK_VesselReportTask_ToLocation] FOREIGN KEY([ToLocationID]) REFERENCES [dbo].[MarineLocation] ([ID]);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_VesselReportTask_Report' AND object_id = OBJECT_ID(N'[dbo].[VesselReportTask]'))
    CREATE NONCLUSTERED INDEX [IX_VesselReportTask_Report] ON [dbo].[VesselReportTask]([VesselDailyReportID] ASC, [SortOrder] ASC);
GO

-- -------------------------------------------------------------------------
-- VesselReportConsumable - fuel, water, base oil, mud tanks (consumables{}).
-- Values stay text ('417.42 M3', '950 M3 (80%)', '-') because that is exactly
-- what the PDFs contain, units and all. Parsing them into decimals is a
-- separate, later decision; storing them raw first means the import cannot
-- silently corrupt a figure.
-- -------------------------------------------------------------------------
IF OBJECT_ID(N'[dbo].[VesselReportConsumable]', N'U') IS NULL
BEGIN
CREATE TABLE [dbo].[VesselReportConsumable](
    [ID]                  [int] IDENTITY(1,1) NOT NULL,
    [VesselDailyReportID] [int] NOT NULL,
    [ConsumableKey]       [varchar](50) NOT NULL,   -- fuel_oil | fresh_water | drill_water | base_oil
    [Label]               [varchar](100) NULL,      -- set for labelled tank/mud rows
    [SortOrder]           [int] NOT NULL,
    [MaxCapacity]         [varchar](50) NULL,
    [Consumed]            [varchar](50) NULL,
    [Loaded]              [varchar](50) NULL,
    [Discharged]          [varchar](50) NULL,
    [Rob]                 [varchar](50) NULL,       -- remaining on board
    [RemainingToLoad]     [varchar](50) NULL,
    [Remarks]             [varchar](500) NULL,
 CONSTRAINT [PK_VesselReportConsumable] PRIMARY KEY CLUSTERED ([ID] ASC)
     WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF,
           ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY];
END
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_VesselReportConsumable_Report')
    ALTER TABLE [dbo].[VesselReportConsumable]
        ADD CONSTRAINT [FK_VesselReportConsumable_Report] FOREIGN KEY([VesselDailyReportID])
        REFERENCES [dbo].[VesselDailyReport] ([ID]) ON DELETE CASCADE;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_VesselReportConsumable_Report' AND object_id = OBJECT_ID(N'[dbo].[VesselReportConsumable]'))
    CREATE NONCLUSTERED INDEX [IX_VesselReportConsumable_Report] ON [dbo].[VesselReportConsumable]([VesselDailyReportID] ASC);
GO

-- -------------------------------------------------------------------------
-- VesselReportCrew - crew and passenger manifest rows (crew[], passengers[]).
-- PersonType separates the two lists, which share a shape.
-- -------------------------------------------------------------------------
IF OBJECT_ID(N'[dbo].[VesselReportCrew]', N'U') IS NULL
BEGIN
CREATE TABLE [dbo].[VesselReportCrew](
    [ID]                  [int] IDENTITY(1,1) NOT NULL,
    [VesselDailyReportID] [int] NOT NULL,
    [PersonType]          [varchar](20) NOT NULL,   -- crew | passenger
    [SortOrder]           [int] NOT NULL,
    [FirstName]           [varchar](100) NULL,
    [LastName]            [varchar](100) NULL,
    [Position]            [varchar](100) NULL,
    [DaysOnboard]         [varchar](50)  NULL,
    [SignOnDate]          [varchar](50)  NULL,      -- free text in the PDFs
    [PlannedCrewChange]   [varchar](50)  NULL,
 CONSTRAINT [PK_VesselReportCrew] PRIMARY KEY CLUSTERED ([ID] ASC)
     WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF,
           ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY];
END
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_VesselReportCrew_Report')
    ALTER TABLE [dbo].[VesselReportCrew]
        ADD CONSTRAINT [FK_VesselReportCrew_Report] FOREIGN KEY([VesselDailyReportID])
        REFERENCES [dbo].[VesselDailyReport] ([ID]) ON DELETE CASCADE;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_VesselReportCrew_Report' AND object_id = OBJECT_ID(N'[dbo].[VesselReportCrew]'))
    CREATE NONCLUSTERED INDEX [IX_VesselReportCrew_Report] ON [dbo].[VesselReportCrew]([VesselDailyReportID] ASC);
GO

-- -------------------------------------------------------------------------
-- MovementPlan - the supervisor's "next 48 hrs" plan. One per plan_date.
--
-- A plan arrives as narrative prose in an email/PDF, and is later curated into
-- structured legs a map can animate. Both live under this one header:
--   * MovementPlanVessel  = the narrative, as received  (data/movement-plans/*.json)
--   * MovementPlanLeg     = the curated structure       (data/plans.json)
-- The two source files cover overlapping but different date ranges, so a plan
-- may have narrative only, structure only, or both.
-- -------------------------------------------------------------------------
IF OBJECT_ID(N'[dbo].[MovementPlan]', N'U') IS NULL
BEGIN
CREATE TABLE [dbo].[MovementPlan](
    [ID]                 [int] IDENTITY(1,1) NOT NULL,
    [PlanDate]           [date] NOT NULL,          -- the plan's "today"
    [IssuedDate]         [date] NULL,              -- when it was sent (usually the evening before)
    [SnapshotAt]         [datetime2](0) NULL,      -- position-as-of moment (Kuwait local)
    [IssuedBy]           [varchar](150) NULL,      -- 'Nirmal Mishra'
    [IssuedRole]         [varchar](255) NULL,
    [Subject]            [varchar](500) NULL,
    [Narrative]          [nvarchar](max) NULL,     -- full email/PDF body, verbatim
    [SourceType]         [varchar](50)  NULL,
    [SourceEmailSubject] [varchar](500) NULL,
    [SourceEmailFrom]    [varchar](255) NULL,
    [SourceEmailDate]    [datetime2](0) NULL,
    [SourceAttachment]   [varchar](500) NULL,
    [SourceSubmittedVia] [varchar](100) NULL,
    [RawJson]            [nvarchar](max) NULL,
    [CreatedOn]          [datetime2](0) NOT NULL,
    [CreatedByUserID]    [int] NULL,
    [ModifiedOn]         [datetime2](0) NULL,
    [ModifiedByUserID]   [int] NULL,
    [IsDeleted]          [bit] NOT NULL,
 CONSTRAINT [PK_MovementPlan] PRIMARY KEY CLUSTERED ([ID] ASC)
     WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF,
           ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY];
END
GO
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = N'DEFAULT_MovementPlan_IsDeleted')
    ALTER TABLE [dbo].[MovementPlan] ADD CONSTRAINT [DEFAULT_MovementPlan_IsDeleted] DEFAULT ((0)) FOR [IsDeleted];
GO
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = N'DEFAULT_MovementPlan_CreatedOn')
    ALTER TABLE [dbo].[MovementPlan] ADD CONSTRAINT [DEFAULT_MovementPlan_CreatedOn]
        DEFAULT (dateadd(hour,(3),getutcdate())) FOR [CreatedOn];
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UQ_MovementPlan_PlanDate' AND object_id = OBJECT_ID(N'[dbo].[MovementPlan]'))
    CREATE UNIQUE NONCLUSTERED INDEX [UQ_MovementPlan_PlanDate] ON [dbo].[MovementPlan]([PlanDate] ASC);
GO

-- -------------------------------------------------------------------------
-- MovementPlanVessel - the per-vessel narrative bullets, exactly as written.
-- Replaces movement-plans/*.json -> vessels[].
-- -------------------------------------------------------------------------
IF OBJECT_ID(N'[dbo].[MovementPlanVessel]', N'U') IS NULL
BEGIN
CREATE TABLE [dbo].[MovementPlanVessel](
    [ID]             [int] IDENTITY(1,1) NOT NULL,
    [MovementPlanID] [int] NOT NULL,
    [VesselID]       [int] NOT NULL,
    [SortOrder]      [int] NOT NULL,
    [CurrentStatus]  [nvarchar](max) NULL,   -- today's bullet
    [TomorrowPlan]   [nvarchar](max) NULL,   -- next-day bullet
    [Additional]     [nvarchar](max) NULL,   -- return legs / conditional plans
    [Notes]          [nvarchar](max) NULL,
 CONSTRAINT [PK_MovementPlanVessel] PRIMARY KEY CLUSTERED ([ID] ASC)
     WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF,
           ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY];
END
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_MovementPlanVessel_Plan')
    ALTER TABLE [dbo].[MovementPlanVessel]
        ADD CONSTRAINT [FK_MovementPlanVessel_Plan] FOREIGN KEY([MovementPlanID])
        REFERENCES [dbo].[MovementPlan] ([ID]) ON DELETE CASCADE;
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_MovementPlanVessel_Vessel')
    ALTER TABLE [dbo].[MovementPlanVessel]
        ADD CONSTRAINT [FK_MovementPlanVessel_Vessel] FOREIGN KEY([VesselID]) REFERENCES [dbo].[Vessel] ([ID]);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UQ_MovementPlanVessel_Plan_Vessel' AND object_id = OBJECT_ID(N'[dbo].[MovementPlanVessel]'))
    CREATE UNIQUE NONCLUSTERED INDEX [UQ_MovementPlanVessel_Plan_Vessel] ON [dbo].[MovementPlanVessel]([MovementPlanID] ASC, [VesselID] ASC);
GO

-- -------------------------------------------------------------------------
-- MovementPlanSnapshot - where each vessel was when the plan was written.
-- Replaces plans.json -> snapshots{}. The simulator uses these to seed a
-- vessel's position before any movement is applied.
-- -------------------------------------------------------------------------
IF OBJECT_ID(N'[dbo].[MovementPlanSnapshot]', N'U') IS NULL
BEGIN
CREATE TABLE [dbo].[MovementPlanSnapshot](
    [ID]               [int] IDENTITY(1,1) NOT NULL,
    [MovementPlanID]   [int] NOT NULL,
    [VesselID]         [int] NOT NULL,
    [MarineLocationID] [int] NULL,
    [RawText]          [varchar](1000) NULL,   -- 'Vessel Currently STBY at Shuaiba Port'
 CONSTRAINT [PK_MovementPlanSnapshot] PRIMARY KEY CLUSTERED ([ID] ASC)
     WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF,
           ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY];
END
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_MovementPlanSnapshot_Plan')
    ALTER TABLE [dbo].[MovementPlanSnapshot]
        ADD CONSTRAINT [FK_MovementPlanSnapshot_Plan] FOREIGN KEY([MovementPlanID])
        REFERENCES [dbo].[MovementPlan] ([ID]) ON DELETE CASCADE;
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_MovementPlanSnapshot_Vessel')
    ALTER TABLE [dbo].[MovementPlanSnapshot]
        ADD CONSTRAINT [FK_MovementPlanSnapshot_Vessel] FOREIGN KEY([VesselID]) REFERENCES [dbo].[Vessel] ([ID]);
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_MovementPlanSnapshot_Location')
    ALTER TABLE [dbo].[MovementPlanSnapshot]
        ADD CONSTRAINT [FK_MovementPlanSnapshot_Location] FOREIGN KEY([MarineLocationID]) REFERENCES [dbo].[MarineLocation] ([ID]);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UQ_MovementPlanSnapshot_Plan_Vessel' AND object_id = OBJECT_ID(N'[dbo].[MovementPlanSnapshot]'))
    CREATE UNIQUE NONCLUSTERED INDEX [UQ_MovementPlanSnapshot_Plan_Vessel] ON [dbo].[MovementPlanSnapshot]([MovementPlanID] ASC, [VesselID] ASC);
GO

-- -------------------------------------------------------------------------
-- MovementPlanLeg - one planned sailing, structured for the map.
-- Replaces plans.json -> movements[]. A movement's optional "return" leg is
-- stored as its own row with LegType='return' and ParentLegID set, so a route
-- out and its return share an order but stay independently editable.
--
-- ViaJson is a JSON array of location codes ('["NP","OPH"]'). Waypoint lists
-- are short, ordered and always read as a whole, so a child table would add a
-- join for no gain.
-- -------------------------------------------------------------------------
IF OBJECT_ID(N'[dbo].[MovementPlanLeg]', N'U') IS NULL
BEGIN
CREATE TABLE [dbo].[MovementPlanLeg](
    [ID]               [int] IDENTITY(1,1) NOT NULL,
    [MovementPlanID]   [int] NOT NULL,
    [VesselID]         [int] NOT NULL,
    [ParentLegID]      [int] NULL,               -- set on 'return' rows
    [LegType]          [varchar](20) NOT NULL,   -- movement | return
    [SortOrder]        [int] NOT NULL,
    [Etd]              [datetime2](0) NULL,      -- Kuwait local
    [Eta]              [datetime2](0) NULL,
    [FromLocationID]   [int] NULL,
    [ToLocationID]     [int] NULL,
    [ViaJson]          [varchar](500) NULL,      -- '["NP","OPH"]'
    [Purpose]          [varchar](255) NULL,      -- 'Crew Change pax'
    [RawText]          [varchar](1000) NULL,     -- the source sentence, verbatim
    [EtdUncertain]     [bit] NOT NULL,           -- source ETD was ambiguous/TBC
    [EtdSource]        [varchar](255) NULL,      -- how a corrected ETD was derived
 CONSTRAINT [PK_MovementPlanLeg] PRIMARY KEY CLUSTERED ([ID] ASC)
     WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF,
           ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY];
END
GO
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = N'DEFAULT_MovementPlanLeg_EtdUncertain')
    ALTER TABLE [dbo].[MovementPlanLeg] ADD CONSTRAINT [DEFAULT_MovementPlanLeg_EtdUncertain] DEFAULT ((0)) FOR [EtdUncertain];
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_MovementPlanLeg_Plan')
    ALTER TABLE [dbo].[MovementPlanLeg]
        ADD CONSTRAINT [FK_MovementPlanLeg_Plan] FOREIGN KEY([MovementPlanID])
        REFERENCES [dbo].[MovementPlan] ([ID]) ON DELETE CASCADE;
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_MovementPlanLeg_Vessel')
    ALTER TABLE [dbo].[MovementPlanLeg]
        ADD CONSTRAINT [FK_MovementPlanLeg_Vessel] FOREIGN KEY([VesselID]) REFERENCES [dbo].[Vessel] ([ID]);
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_MovementPlanLeg_ParentLeg')
    ALTER TABLE [dbo].[MovementPlanLeg]
        ADD CONSTRAINT [FK_MovementPlanLeg_ParentLeg] FOREIGN KEY([ParentLegID]) REFERENCES [dbo].[MovementPlanLeg] ([ID]);
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_MovementPlanLeg_FromLocation')
    ALTER TABLE [dbo].[MovementPlanLeg]
        ADD CONSTRAINT [FK_MovementPlanLeg_FromLocation] FOREIGN KEY([FromLocationID]) REFERENCES [dbo].[MarineLocation] ([ID]);
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_MovementPlanLeg_ToLocation')
    ALTER TABLE [dbo].[MovementPlanLeg]
        ADD CONSTRAINT [FK_MovementPlanLeg_ToLocation] FOREIGN KEY([ToLocationID]) REFERENCES [dbo].[MarineLocation] ([ID]);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_MovementPlanLeg_Plan' AND object_id = OBJECT_ID(N'[dbo].[MovementPlanLeg]'))
    CREATE NONCLUSTERED INDEX [IX_MovementPlanLeg_Plan] ON [dbo].[MovementPlanLeg]([MovementPlanID] ASC, [SortOrder] ASC);
GO

-- -------------------------------------------------------------------------
-- AisPosition - vessel positions from the AIS feed (imported history + live).
--
-- Timestamps here are UTC, unlike every other table in this file. The feed
-- publishes UTC and re-basing it to Kuwait local on ingest would corrupt the
-- one dataset whose zone is unambiguous. The suffix is the warning.
--
-- bigint ID: a single vessel polled every 2 minutes is ~260k rows a year,
-- and this table only ever grows.
-- -------------------------------------------------------------------------
IF OBJECT_ID(N'[dbo].[AisPosition]', N'U') IS NULL
BEGIN
CREATE TABLE [dbo].[AisPosition](
    [ID]           [bigint] IDENTITY(1,1) NOT NULL,
    [VesselID]     [int] NOT NULL,
    [TimestampUtc] [datetime2](0) NOT NULL,
    [Latitude]     [decimal](10, 7) NOT NULL,
    [Longitude]    [decimal](10, 7) NOT NULL,
    [SpeedKts]     [decimal](6, 2) NULL,   -- sog
    [CourseDeg]    [decimal](6, 2) NULL,   -- cog
    [HeadingDeg]   [decimal](6, 2) NULL,
    [NavStatus]    [varchar](100) NULL,    -- 'Restricted manoeuverability'
    [MMSI]         [varchar](20)  NULL,    -- as reported, for cross-checking
    [Source]       [varchar](50)  NOT NULL,-- datalastic | aisstream | import
 CONSTRAINT [PK_AisPosition] PRIMARY KEY CLUSTERED ([ID] ASC)
     WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF,
           ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY];
END
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_AisPosition_Vessel')
    ALTER TABLE [dbo].[AisPosition]
        ADD CONSTRAINT [FK_AisPosition_Vessel] FOREIGN KEY([VesselID]) REFERENCES [dbo].[Vessel] ([ID]);
GO
-- Every query is "positions for vessel X between two times".
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_AisPosition_Vessel_Time' AND object_id = OBJECT_ID(N'[dbo].[AisPosition]'))
    CREATE NONCLUSTERED INDEX [IX_AisPosition_Vessel_Time] ON [dbo].[AisPosition]([VesselID] ASC, [TimestampUtc] ASC);
GO
-- The importer is re-runnable and the live poller can repeat a fix; this makes
-- a duplicate position impossible rather than merely unlikely.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UQ_AisPosition_Vessel_Time_Source' AND object_id = OBJECT_ID(N'[dbo].[AisPosition]'))
    CREATE UNIQUE NONCLUSTERED INDEX [UQ_AisPosition_Vessel_Time_Source]
        ON [dbo].[AisPosition]([VesselID] ASC, [TimestampUtc] ASC, [Source] ASC);
GO

PRINT '002-marine-tables.sql complete.';
GO
