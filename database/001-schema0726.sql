USE [DWO]
GO
/****** Object:  Table [dbo].[Activity]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[Activity](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[ActivityName] [varchar](50) NULL,
	[IsActive] [bit] NULL,
	[IsDeleted] [bit] NULL,
 CONSTRAINT [PK_Activity] PRIMARY KEY CLUSTERED 
(
	[ID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[ActualWellInfo]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[ActualWellInfo](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[CompletionCost] [decimal](18, 2) NULL,
	[WellID] [int] NULL,
 CONSTRAINT [PK_ActualWellInfo] PRIMARY KEY CLUSTERED 
(
	[ID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[AFE]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[AFE](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[AFENumber] [int] NOT NULL,
	[ProjectID] [int] NULL,
	[IsActive] [bit] NOT NULL,
	[IsDeleted] [bit] NULL,
 CONSTRAINT [PK_AFE] PRIMARY KEY CLUSTERED 
(
	[ID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[AFEInfo]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[AFEInfo](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[AFEID] [int] NULL,
	[WellID] [int] NULL,
	[BudgetYearID] [int] NULL,
	[FDName] [varchar](100) NULL,
	[AFEScopeChangeID] [int] NULL,
	[CustodianCode] [varchar](50) NULL,
	[UnplannedChange] [varchar](255) NULL,
	[ProfileID] [int] NULL,
	[SeriesName] [varchar](50) NULL,
 CONSTRAINT [PK_AFEInfo] PRIMARY KEY CLUSTERED 
(
	[ID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[AFERevision]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[AFERevision](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[AFEID] [int] NOT NULL,
	[RevisionDetails] [varchar](255) NOT NULL,
	[RevisionReason] [varchar](500) NULL,
 CONSTRAINT [PK_AFERevision] PRIMARY KEY CLUSTERED 
(
	[ID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[AFEScopeChange]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[AFEScopeChange](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[WellID] [int] NULL,
	[AFEInfoID] [int] NULL,
	[SC1] [varchar](255) NULL,
	[SC1ProfileID] [int] NULL,
	[SC1Remarks] [varchar](500) NULL,
	[SC2] [varchar](255) NULL,
	[SC2ProfileID] [int] NULL,
	[SC2Remarks] [varchar](500) NULL,
	[SC3] [varchar](255) NULL,
	[SC3ProfileID] [int] NULL,
	[SC3Remarks] [varchar](500) NULL,
	[ScopeChangeIndicator] [int] NULL,
 CONSTRAINT [PK_AFEScopeChange] PRIMARY KEY CLUSTERED 
(
	[ID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[Asset]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[Asset](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[AssetName] [varchar](255) NOT NULL,
	[AssetAbbreviation] [varchar](10) NOT NULL,
	[IsActive] [bit] NOT NULL,
	[IsDeleted] [bit] NOT NULL,
 CONSTRAINT [PK_Area] PRIMARY KEY CLUSTERED 
(
	[ID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[BudgetProposal]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[BudgetProposal](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[AFEInfoID] [int] NULL,
	[BudgetYearID] [int] NULL,
	[WellCost] [decimal](18, 2) NULL,
	[EstimatedDepth] [decimal](18, 0) NULL,
	[PlannedDays] [int] NULL,
	[OriginalBPCount] [int] NULL,
	[FinalStatusID] [int] NULL,
	[CompletionCost] [decimal](18, 2) NULL,
 CONSTRAINT [PK_BudgetProposal] PRIMARY KEY CLUSTERED 
(
	[ID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[BudgetYear]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[BudgetYear](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[StartYear] [int] NOT NULL,
	[EndYear] [int] NOT NULL,
 CONSTRAINT [PK_BudgetYear] PRIMARY KEY CLUSTERED 
(
	[ID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[CompletionType]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[CompletionType](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[CompletionTypeName] [varchar](20) NOT NULL,
	[CompletionTypeAbbreviation] [varchar](10) NULL,
	[IsActive] [bit] NULL,
 CONSTRAINT [PK_CompletionType] PRIMARY KEY CLUSTERED 
(
	[ID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[Contract]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[Contract](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[ContractTitle] [varchar](150) NOT NULL,
	[ContractStartDate] [datetime] NULL,
	[ContractEndDate] [datetime] NULL,
	[ContractorID] [int] NULL,
	[isActive] [bit] NOT NULL,
	[isDeleted] [bit] NOT NULL,
 CONSTRAINT [PK_Contract] PRIMARY KEY CLUSTERED 
(
	[ID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[Contractor]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[Contractor](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[ContractorName] [varchar](150) NOT NULL,
	[ContractorCode] [varchar](15) NULL,
	[isActive] [bit] NULL,
	[isDeleted] [bit] NULL,
 CONSTRAINT [PK_Contractor] PRIMARY KEY CLUSTERED 
(
	[ID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[Drilling]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[Drilling](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[WellID] [int] NULL,
	[DrilledYearID] [int] NULL,
	[RigID] [int] NULL,
	[RigInfoID] [int] NULL,
	[StatusID] [int] NULL,
	[StartDate] [datetime] NULL,
	[SpudDate] [datetime] NULL,
	[ReleaseDate] [datetime] NULL,
	[Remarks] [varchar](1000) NULL,
	[BudgetYearID] [int] NULL,
	[ActualTD] [decimal](18, 0) NULL,
	[PriorFDNames] [varchar](100) NULL,
	[ProjectNumber] [varchar](50) NULL,
	[AFENumber] [int] NULL,
	[BMSeriesName] [varchar](100) NULL,
	[TestingDate] [datetime] NULL,
	[NPTOngoing] [bit] NULL,
 CONSTRAINT [PK_Drilling] PRIMARY KEY CLUSTERED 
(
	[ID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[Entity]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[Entity](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[EntityCode] [varchar](50) NOT NULL,
	[EntityName] [varchar](255) NOT NULL,
	[EntityTypeID] [int] NOT NULL,
	[ParentEntityID] [int] NULL,
	[Description] [varchar](255) NULL,
	[IsActive] [bit] NOT NULL,
	[IsVirtual] [int] NOT NULL,
 CONSTRAINT [PK_Entity] PRIMARY KEY CLUSTERED 
(
	[ID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[EntityType]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[EntityType](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[TypeName] [varchar](50) NOT NULL,
	[Description] [varchar](255) NULL,
	[IsActive] [bit] NOT NULL,
 CONSTRAINT [PK_EntityType] PRIMARY KEY CLUSTERED 
(
	[ID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[Field]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[Field](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[FieldName] [varchar](50) NOT NULL,
	[FieldAbbreviation] [varchar](50) NOT NULL,
	[AssetID] [int] NOT NULL,
	[IsActive] [bit] NULL,
	[IsDeleted] [bit] NULL,
 CONSTRAINT [PK_Field] PRIMARY KEY CLUSTERED 
(
	[ID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[Form]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[Form](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[FormName] [varchar](100) NOT NULL,
	[Description] [varchar](255) NULL,
	[ModuleID] [int] NULL,
	[ParentFormID] [int] NULL,
	[DisplayOrder] [int] NULL,
	[PrivilegeID] [int] NULL,
	[IsActive] [bit] NOT NULL,
 CONSTRAINT [PK_Form] PRIMARY KEY CLUSTERED 
(
	[ID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[Log]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[Log](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[UserID] [int] NOT NULL,
	[Event] [nvarchar](100) NOT NULL,
	[EventDetails] [nvarchar](max) NULL,
	[ModuleID] [int] NOT NULL,
	[Timestamp] [datetime] NOT NULL,
	[Username] [varchar](50) NULL,
 CONSTRAINT [PK_Log] PRIMARY KEY CLUSTERED 
(
	[ID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY]
GO
/****** Object:  Table [dbo].[Module]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[Module](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[ModuleName] [varchar](100) NOT NULL,
	[Description] [varchar](255) NULL,
	[ParentModuleID] [int] NULL,
	[DisplayOrder] [int] NULL,
	[PrivilegeID] [int] NULL,
	[IsAttachedToMenu] [bit] NOT NULL,
	[IsActive] [bit] NOT NULL,
 CONSTRAINT [PK_Module] PRIMARY KEY CLUSTERED 
(
	[ID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[Privilege]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[Privilege](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[PrivilegeName] [varchar](255) NOT NULL,
	[PrivilegeParentId] [int] NULL,
	[Remarks] [varchar](500) NULL,
	[IsActive] [bit] NOT NULL
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[Profile]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[Profile](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[AFEInfoID] [int] NULL,
	[WellID] [int] NULL,
	[ProfileName] [varchar](255) NULL,
	[ProfileTypeID] [int] NULL,
	[BudgetYearID] [int] NULL,
	[IsActive] [bit] NOT NULL,
	[IsDeleted] [bit] NOT NULL,
 CONSTRAINT [PK_Profile] PRIMARY KEY CLUSTERED 
(
	[ID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[ProfileType]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[ProfileType](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[Type] [varchar](50) NULL,
 CONSTRAINT [PK_ProfileType] PRIMARY KEY CLUSTERED 
(
	[ID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[Project]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[Project](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[ProjectNumber] [varchar](50) NULL,
	[ProjectName] [varchar](255) NOT NULL,
	[Description] [varchar](500) NULL,
	[AssetID] [int] NULL,
	[BudgetYearID] [int] NULL,
	[StatusID] [int] NULL,
	[IsActive] [bit] NOT NULL,
	[IsDeleted] [bit] NOT NULL,
 CONSTRAINT [PK_Project] PRIMARY KEY CLUSTERED 
(
	[ID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[Rig]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[Rig](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[RigName] [varchar](100) NOT NULL,
	[Description] [varchar](255) NULL,
	[IsActive] [bit] NOT NULL,
	[IsDeleted] [bit] NOT NULL,
 CONSTRAINT [PK_Rig] PRIMARY KEY CLUSTERED 
(
	[ID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[RigInfo]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[RigInfo](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[ContractID] [int] NULL,
	[RigID] [int] NOT NULL,
	[ActivityID] [int] NULL,
	[TeamID] [int] NULL,
	[RigStatusID] [int] NULL,
	[AssetID] [int] NULL,
	[ContractRigHP_BOP] [varchar](50) NULL,
	[ActualRigHP] [varchar](50) NULL,
 CONSTRAINT [PK_RigInfo] PRIMARY KEY CLUSTERED 
(
	[ID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[RigType]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[RigType](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[RigTypeName] [varchar](50) NOT NULL,
	[RigTypeAbbreviation] [varchar](10) NULL,
	[IsActive] [bit] NULL,
 CONSTRAINT [PK_RigType] PRIMARY KEY CLUSTERED 
(
	[ID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[Role]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[Role](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[RoleName] [varchar](255) NOT NULL,
	[StartDate] [datetime] NULL,
	[EndDate] [datetime] NULL,
	[Remarks] [varchar](500) NULL,
	[IsActive] [bit] NOT NULL
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[RolePrivilege]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[RolePrivilege](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[PrivilegeID] [int] NULL,
	[RoleID] [int] NULL
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[Series]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[Series](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[SeriesName] [varchar](255) NULL,
	[WellID] [int] NULL,
	[BudgetYearID] [int] NULL,
 CONSTRAINT [PK_Series] PRIMARY KEY CLUSTERED 
(
	[ID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[Status]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[Status](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[ModuleID] [int] NULL,
	[Status] [varchar](50) NOT NULL,
	[Description] [varchar](255) NULL,
	[IsActive] [bit] NOT NULL,
	[DisplayOrder] [int] NULL,
	[StatusCategory] [varchar](50) NULL,
 CONSTRAINT [PK_Status] PRIMARY KEY CLUSTERED 
(
	[ID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[TrajectoryType]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[TrajectoryType](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[TrajectoryTypeName] [varchar](50) NOT NULL,
	[TrajectoryTypeAbbreviation] [varchar](10) NULL,
	[IsActive] [bit] NULL,
	[IsDeleted] [bit] NULL,
 CONSTRAINT [PK_TrajectoryType] PRIMARY KEY CLUSTERED 
(
	[ID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[User]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[User](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[Username] [varchar](50) NULL,
	[StartDate] [datetime] NULL,
	[ExpiryDate] [datetime] NULL,
	[Password] [varchar](64) NULL,
	[PasswordHash] [varbinary](512) NULL,
	[PasswordSalt] [varbinary](512) NULL,
	[IsActive] [bit] NOT NULL,
	[IsDeleted] [bit] NOT NULL,
 CONSTRAINT [PK_User] PRIMARY KEY CLUSTERED 
(
	[ID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[UserAccessLog]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[UserAccessLog](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[UserID] [int] NOT NULL,
	[Username] [nvarchar](100) NULL,
	[AccessTime] [datetime] NULL,
PRIMARY KEY CLUSTERED 
(
	[ID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[UserPrivilege]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[UserPrivilege](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[UserID] [int] NULL,
	[PrivilegeID] [int] NULL,
	[StartDate] [datetime] NULL,
	[EndDate] [datetime] NULL
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[UserProfile]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[UserProfile](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[UserID] [int] NULL,
	[KOCNumber] [int] NOT NULL,
	[FirstName] [varchar](50) NOT NULL,
	[LastName] [varchar](50) NOT NULL,
	[Email] [varchar](50) NULL,
	[Gender] [varchar](10) NULL,
	[Designation] [varchar](50) NULL,
	[IsKOC] [bit] NULL,
	[ContractorID] [int] NULL,
	[Extension] [varchar](15) NULL,
	[Mobile] [varchar](15) NULL,
 CONSTRAINT [PK_UserProfile] PRIMARY KEY CLUSTERED 
(
	[ID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[UserRole]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[UserRole](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[UserID] [int] NOT NULL,
	[RoleID] [int] NOT NULL,
	[StartDate] [datetime] NULL,
	[EndDate] [datetime] NULL
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[Well]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[Well](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[WellName] [varchar](50) NOT NULL,
	[AssetID] [int] NULL,
	[FieldID] [int] NULL,
	[ZoneID] [int] NULL,
	[Latitude] [decimal](10, 7) NULL,
	[Longitude] [decimal](10, 7) NULL,
	[Description] [varchar](500) NULL,
	[IsActive] [bit] NOT NULL,
	[IsDeleted] [bit] NOT NULL,
 CONSTRAINT [PK_Well] PRIMARY KEY CLUSTERED 
(
	[ID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[WellInfo]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[WellInfo](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[WellID] [int] NULL,
	[SCIndicator] [bit] NOT NULL,
	[SeriesID] [int] NOT NULL,
	[DrillingYear] [int] NULL,
	[DrillingMonth] [int] NULL,
	[StartDate] [datetime] NULL,
	[DrillingSpudDate] [datetime] NULL,
	[DrillingDays] [decimal](18, 0) NULL,
	[CompletionSpudDate] [datetime] NULL,
	[CompletionDays] [decimal](18, 0) NULL,
 CONSTRAINT [PK_WellInfo] PRIMARY KEY CLUSTERED 
(
	[ID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[WellProfile]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[WellProfile](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[WellID] [int] NOT NULL,
	[ProfileID] [int] NOT NULL,
 CONSTRAINT [PK_WellProfile] PRIMARY KEY CLUSTERED 
(
	[ID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[WellType]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[WellType](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[WellTypeName] [varchar](50) NOT NULL,
	[WellTypeAbbreviation] [varchar](10) NULL,
	[IsActive] [bit] NULL,
	[IsDeleted] [bit] NULL,
 CONSTRAINT [PK_WellType] PRIMARY KEY CLUSTERED 
(
	[ID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[WellTypeHistory]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[WellTypeHistory](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[WellID] [int] NOT NULL,
	[WellTypeID] [int] NULL,
	[ModifiedOn] [datetime] NULL,
	[ModifiedBy] [int] NULL,
 CONSTRAINT [PK_WellTypeHistory] PRIMARY KEY CLUSTERED 
(
	[ID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[Workover]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[Workover](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[RigTypeID] [int] NULL,
	[ActivityID] [int] NULL,
	[StatusID] [int] NULL,
	[AssetID] [int] NULL,
	[TeamID] [int] NULL,
	[RigID] [int] NULL,
	[WellID] [int] NULL,
	[WOSeriesName] [nvarchar](100) NULL,
	[PlannedObjective] [nvarchar](1500) NULL,
	[WOCost] [decimal](18, 2) NULL,
	[OracleCost] [decimal](18, 2) NULL,
	[FormationObjective] [nvarchar](1500) NULL,
	[Objective] [nvarchar](1500) NULL,
	[Remarks] [nvarchar](1500) NULL,
	[StartDate] [datetime] NULL,
	[SpudDate] [datetime] NULL,
	[ReleaseDate] [datetime] NULL,
	[PlannedDays] [int] NULL,
	[EventFinalObjective] [nvarchar](1500) NULL,
 CONSTRAINT [PK_Workover] PRIMARY KEY CLUSTERED 
(
	[ID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[Zone]    Script Date: 7/16/2026 1:48:05 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[Zone](
	[ID] [int] IDENTITY(1,1) NOT NULL,
	[ZoneName] [varchar](255) NOT NULL,
	[ZoneAbbreviation] [varchar](50) NULL,
	[FieldID] [int] NULL,
	[IsActive] [bit] NULL,
	[IsDeleted] [bit] NULL,
 CONSTRAINT [PK_Zone] PRIMARY KEY CLUSTERED 
(
	[ID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
ALTER TABLE [dbo].[AFE] ADD  CONSTRAINT [DEFAULT_AFE_IsActive]  DEFAULT ((1)) FOR [IsActive]
GO
ALTER TABLE [dbo].[AFE] ADD  CONSTRAINT [DEFAULT_AFE_IsDeleted]  DEFAULT ((0)) FOR [IsDeleted]
GO
ALTER TABLE [dbo].[Asset] ADD  CONSTRAINT [DEFAULT_Asset_IsActive]  DEFAULT ((1)) FOR [IsActive]
GO
ALTER TABLE [dbo].[Asset] ADD  CONSTRAINT [DEFAULT_Asset_IsDeleted]  DEFAULT ((0)) FOR [IsDeleted]
GO
ALTER TABLE [dbo].[CompletionType] ADD  CONSTRAINT [DEFAULT_CompletionType_IsActive]  DEFAULT ((1)) FOR [IsActive]
GO
ALTER TABLE [dbo].[Contract] ADD  CONSTRAINT [DEFAULT_Contract_isActive]  DEFAULT ((1)) FOR [isActive]
GO
ALTER TABLE [dbo].[Contract] ADD  CONSTRAINT [DEFAULT_Contract_isDeleted]  DEFAULT ((0)) FOR [isDeleted]
GO
ALTER TABLE [dbo].[Contractor] ADD  CONSTRAINT [DEFAULT_Contractor_isActive]  DEFAULT ((1)) FOR [isActive]
GO
ALTER TABLE [dbo].[Contractor] ADD  CONSTRAINT [DEFAULT_Contractor_isDeleted]  DEFAULT ((0)) FOR [isDeleted]
GO
ALTER TABLE [dbo].[Drilling] ADD  CONSTRAINT [DF_Drilling_NPTOngoing]  DEFAULT ((0)) FOR [NPTOngoing]
GO
ALTER TABLE [dbo].[Entity] ADD  CONSTRAINT [DEFAULT_Entity_IsActive]  DEFAULT ((1)) FOR [IsActive]
GO
ALTER TABLE [dbo].[Entity] ADD  CONSTRAINT [DEFAULT_Entity_IsVirtual]  DEFAULT ((0)) FOR [IsVirtual]
GO
ALTER TABLE [dbo].[EntityType] ADD  CONSTRAINT [DEFAULT_EntityType_IsActive]  DEFAULT ((1)) FOR [IsActive]
GO
ALTER TABLE [dbo].[Field] ADD  CONSTRAINT [DEFAULT_Field_IsActive]  DEFAULT ((1)) FOR [IsActive]
GO
ALTER TABLE [dbo].[Field] ADD  CONSTRAINT [DEFAULT_Field_IsDeleted]  DEFAULT ((0)) FOR [IsDeleted]
GO
ALTER TABLE [dbo].[Form] ADD  CONSTRAINT [DEFAULT_Form_IsActive]  DEFAULT ((1)) FOR [IsActive]
GO
ALTER TABLE [dbo].[Log] ADD  CONSTRAINT [DF_Log_Timestamp]  DEFAULT (dateadd(hour,(3),getdate())) FOR [Timestamp]
GO
ALTER TABLE [dbo].[Module] ADD  CONSTRAINT [DEFAULT_Module_IsAttachedToMenu]  DEFAULT ((1)) FOR [IsAttachedToMenu]
GO
ALTER TABLE [dbo].[Module] ADD  CONSTRAINT [DEFAULT_Module_IsActive]  DEFAULT ((1)) FOR [IsActive]
GO
ALTER TABLE [dbo].[Privilege] ADD  CONSTRAINT [DEFAULT_Privilege_IsActive]  DEFAULT ((1)) FOR [IsActive]
GO
ALTER TABLE [dbo].[Profile] ADD  CONSTRAINT [DEFAULT_Profile_IsActive]  DEFAULT ((1)) FOR [IsActive]
GO
ALTER TABLE [dbo].[Profile] ADD  CONSTRAINT [DEFAULT_Profile_IsDeleted]  DEFAULT ((0)) FOR [IsDeleted]
GO
ALTER TABLE [dbo].[Project] ADD  CONSTRAINT [DEFAULT_Project_IsActive]  DEFAULT ((1)) FOR [IsActive]
GO
ALTER TABLE [dbo].[Project] ADD  CONSTRAINT [DEFAULT_Project_IsDeleted]  DEFAULT ((0)) FOR [IsDeleted]
GO
ALTER TABLE [dbo].[Rig] ADD  CONSTRAINT [DEFAULT_Rig_IsActive]  DEFAULT ((1)) FOR [IsActive]
GO
ALTER TABLE [dbo].[Rig] ADD  CONSTRAINT [DEFAULT_Rig_IsDeleted]  DEFAULT ((0)) FOR [IsDeleted]
GO
ALTER TABLE [dbo].[RigType] ADD  CONSTRAINT [DEFAULT_RigType_IsActive]  DEFAULT ((1)) FOR [IsActive]
GO
ALTER TABLE [dbo].[Role] ADD  CONSTRAINT [DEFAULT_Role_IsActive]  DEFAULT ((1)) FOR [IsActive]
GO
ALTER TABLE [dbo].[Status] ADD  CONSTRAINT [DEFAULT_Status_IsActive]  DEFAULT ((1)) FOR [IsActive]
GO
ALTER TABLE [dbo].[TrajectoryType] ADD  CONSTRAINT [DEFAULT_TrajectoryType_IsActive]  DEFAULT ((1)) FOR [IsActive]
GO
ALTER TABLE [dbo].[TrajectoryType] ADD  CONSTRAINT [DEFAULT_TrajectoryType_IsDeleted]  DEFAULT ((0)) FOR [IsDeleted]
GO
ALTER TABLE [dbo].[User] ADD  CONSTRAINT [DEFAULT_User_IsActive]  DEFAULT ((1)) FOR [IsActive]
GO
ALTER TABLE [dbo].[User] ADD  CONSTRAINT [DEFAULT_User_IsDeleted]  DEFAULT ((0)) FOR [IsDeleted]
GO
ALTER TABLE [dbo].[UserAccessLog] ADD  DEFAULT (getdate()) FOR [AccessTime]
GO
ALTER TABLE [dbo].[UserProfile] ADD  CONSTRAINT [DEFAULT_UserProfile_KOCNumber]  DEFAULT ((0)) FOR [KOCNumber]
GO
ALTER TABLE [dbo].[Well] ADD  CONSTRAINT [DEFAULT_Well_IsActive]  DEFAULT ((1)) FOR [IsActive]
GO
ALTER TABLE [dbo].[Well] ADD  CONSTRAINT [DEFAULT_Well_IsDeleted]  DEFAULT ((0)) FOR [IsDeleted]
GO
ALTER TABLE [dbo].[WellType] ADD  CONSTRAINT [DEFAULT_WellType_IsActive]  DEFAULT ((1)) FOR [IsActive]
GO
ALTER TABLE [dbo].[WellType] ADD  CONSTRAINT [DEFAULT_WellType_IsDeleted]  DEFAULT ((0)) FOR [IsDeleted]
GO
ALTER TABLE [dbo].[Zone] ADD  CONSTRAINT [DEFAULT_Zone_IsActive]  DEFAULT ((1)) FOR [IsActive]
GO
ALTER TABLE [dbo].[Zone] ADD  CONSTRAINT [DEFAULT_Zone_IsDeleted]  DEFAULT ((0)) FOR [IsDeleted]
GO
ALTER TABLE [dbo].[Entity]  WITH CHECK ADD  CONSTRAINT [FK_Entity_EntityType] FOREIGN KEY([EntityTypeID])
REFERENCES [dbo].[EntityType] ([ID])
GO
ALTER TABLE [dbo].[Entity] CHECK CONSTRAINT [FK_Entity_EntityType]
GO
ALTER TABLE [dbo].[Field]  WITH CHECK ADD  CONSTRAINT [FK_Field_Area] FOREIGN KEY([AssetID])
REFERENCES [dbo].[Asset] ([ID])
GO
ALTER TABLE [dbo].[Field] CHECK CONSTRAINT [FK_Field_Area]
GO
ALTER TABLE [dbo].[Status]  WITH CHECK ADD  CONSTRAINT [FK_Status_Module] FOREIGN KEY([ModuleID])
REFERENCES [dbo].[Module] ([ID])
GO
ALTER TABLE [dbo].[Status] CHECK CONSTRAINT [FK_Status_Module]
GO
ALTER TABLE [dbo].[WellTypeHistory]  WITH CHECK ADD  CONSTRAINT [FK_WellTypeHistory_Well] FOREIGN KEY([WellID])
REFERENCES [dbo].[Well] ([ID])
GO
ALTER TABLE [dbo].[WellTypeHistory] CHECK CONSTRAINT [FK_WellTypeHistory_Well]
GO
ALTER TABLE [dbo].[Workover]  WITH CHECK ADD  CONSTRAINT [FK_Workover_Rig] FOREIGN KEY([RigID])
REFERENCES [dbo].[Rig] ([ID])
GO
ALTER TABLE [dbo].[Workover] CHECK CONSTRAINT [FK_Workover_Rig]
GO
ALTER TABLE [dbo].[Workover]  WITH CHECK ADD  CONSTRAINT [FK_Workover_Well] FOREIGN KEY([WellID])
REFERENCES [dbo].[Well] ([ID])
GO
ALTER TABLE [dbo].[Workover] CHECK CONSTRAINT [FK_Workover_Well]
GO
ALTER TABLE [dbo].[Zone]  WITH CHECK ADD  CONSTRAINT [FK_Zone_Field] FOREIGN KEY([FieldID])
REFERENCES [dbo].[Field] ([ID])
GO
ALTER TABLE [dbo].[Zone] CHECK CONSTRAINT [FK_Zone_Field]
GO
