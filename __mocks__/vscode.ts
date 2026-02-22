// Minimal vscode mock for unit tests
export const window = {
  showQuickPick: async () => undefined,
  showInputBox: async () => undefined,
  showInformationMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  withProgress: async (_options: any, task: any) => task(),
};

export const workspace = {
  getConfiguration: () => ({
    get: () => undefined,
  }),
  workspaceFolders: [],
};

export const Uri = {
  joinPath: (...args: any[]) => ({ fsPath: args.join("/") }),
};

export class TreeItem {
  constructor(public label: string) {}
}

export const ViewColumn = { One: 1 };

export const ProgressLocation = { Notification: 15 };
