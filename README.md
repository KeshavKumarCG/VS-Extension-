# Build Logger 🛠️📊

A Visual Studio Code extension that tracks build failures, collects contextual information, and provides insightful analytics through an interactive dashboard.



## Features 🚀

- **Build Failure Tracking**: Automatically logs failed builds with context
- **Smart Dashboard**: Visual analytics of build failures with:
  - Developer-specific statistics
  - Branch-wise failure distribution
  - Common error patterns
  - Command execution history
- **Git Integration**: Auto-detects:
  - Current branch
  - Developer name (from git config or system)
- **Export Capabilities**: Save logs as JSON for further analysis
- **Safety Features**:
  - Log rotation (keeps last 1000 entries)
  - Error message sanitization
  - Command injection protection

## Installation 📦

1. Open **VS Code**
2. Copy and run the following commands in your terminal:
   ```bash
   vsce package
   code --install-extension build-logger-0.0.2.vsix
   ```
3. Reload VS Code when prompted

## Usage 🖱️

### Track Builds
1. Open your project in VS Code
2. Open command palette (`Ctrl+Shift+P`)
3. Select **"Track Builds"**
4. Watch real-time build output in dedicated terminal
5. Power BI integration via firebase 

### View Dashboard
1. After at least one failed build:
2. Open command palette (`Ctrl+Shift+P`)
3. Select **"Show Build Dashboard"**
4. Explore failure statistics and patterns

### Key Commands
| Command                | Shortcut  | Description                     |
|------------------------|-----------|---------------------------------|
| Track Builds           | `Ctrl+Alt+B` | Start monitoring build process |
| Show Build Dashboard   | `Ctrl+Alt+D` | Open analytics dashboard with AI Intgration |

## Configuration ⚙️

Add to your VS Code `settings.json`:
```json
{
  "build-logger.buildCommand": "npm run build",
  "build-logger.logFilePath": "logs/build_errors.json"
}
```

**Options**:
- `buildCommand`: Custom build command (default: `npm run build`)
- `logFilePath`: Relative path for log storage (default: `build_logs.json`)

> **Security Note**: Build commands are validated to prevent injection attacks

## Development 🛠️

### Requirements
- Node.js 16+
- VS Code 1.75+

### Setup
```bash
git clone https://github.com/KeshavKumarCG/VS-Extension-.git
cd VS-Extension-
npm install
```

### Build & Test
| Command               | Description                          |
|-----------------------|--------------------------------------|
| `npm run build`       | Compile production build            |
| `npm run watch`       | Start development watch mode        |
| `npm test`            | Run test suite                      |
| `npm run package`     | Create VSIX package for distribution|

## Contributing 🤝

We welcome contributions! Please follow these steps:
1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes
4. Push to branch
5. Open a Pull Request


---

**Happy Coding!** 🎉  

*Maintained by [Keshav Kumar](https://github.com/KeshavKumarCG)*  
*Maintained by [Harshdeep Singh](https://github.com/HarshdeepSinghCG)*  
*Maintained by [Gursimran Kaur](https://github.com/GursimranKaur1112)*  
*Maintained by [Anushka Soni](https://github.com/anushkasoniCG)*  
*Maintained by [Shantanu Sahoo](https://github.com/Cgshantanu)*  