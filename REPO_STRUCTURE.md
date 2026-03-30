# Repository Structure and Code Flow

## Overview
This repository is structured to support both frontend and backend components of an audit agent, providing a cohesive architecture for building, serving, and evaluating audit requests.

## Directory Structure
- **client/src/**: This contains the frontend code, responsible for rendering the UI and interacting with backend services.
- **server/**: The backend codebase responsible for handling services, evaluations, and processing logic.
- **.config/**: Houses configuration files for setup and environment management.

## Client Code (Frontend)
### Components
- **UI Components**:
  - `AIChatBox.tsx`: Manages chat interfaces for interactions.
  - `DashboardLayout.tsx`: Provides the main dashboard layout.
  - `ui/`: Various reusable UI components like buttons, dialogs, cards, etc.

### Pages
- **AuditPage.tsx**: Displays audit results and interfacing components for manipulating audits.

### Hooks and Contexts
- **useMobile.tsx**: Custom hook to manage mobile behaviors.
- **ThemeContext.tsx**: Provides theming contexts.

## Server Code (Backend)
### Services
- **urlFetcher.ts**: Utility for fetching and handling URL requests.

### Routers
- **routers.ts**: Central routing configuration to navigate through API endpoints.

## Shared Configuration
- **.env.example**: Example file showcasing required environment variables.
- **tsconfig.json**: TypeScript configuration for code compilation.

## Build and Configuration
- **vite.config.ts** and **vitest.config.ts**: Build and test configurations for development environments.

## Documentation and Setup
- **package.json**: Lists all dependencies and scripts necessary to run the application.
