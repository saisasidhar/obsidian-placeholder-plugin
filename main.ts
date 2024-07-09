import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, MarkdownPostProcessorContext, WorkspaceLeaf } from 'obsidian';
import { EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';
import { RangeSetBuilder, EditorState, Transaction } from '@codemirror/state';

interface PlaceholderPluginSettings {
	reviewPlaceholdersOnStart: boolean;
}

const DEFAULT_SETTINGS: PlaceholderPluginSettings = {
	reviewPlaceholdersOnStart: false
}


export default class PlaceholderPlugin extends Plugin {
	settings: PlaceholderPluginSettings;
	modal: HTMLElement | null = null;
	count: Number = 0;
	statusBarItemEl: HTMLElement

	async onload() {
		// Load plugin settings
		await this.loadSettings();

		this.addCss();

		// Register extension for CodeMirror editor
		this.registerEditorExtension(this.highlightPlaceholderInEditor());
		// Register the Markdown post-processor
		this.registerMarkdownPostProcessor(this.highlightPlaceholderInReader);

		// This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		this.statusBarItemEl = this.addStatusBarItem();
		// Add a ribbon icon
		const ribbonIconEl = this.addRibbonIcon('blocks', 'Review Placeholders', (evt: MouseEvent) => {
			this.showReviewPlaceholdersModal();
		});
		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new PlaceholderSettingTab(this.app, this));

		// This adds a simple command that can be triggered anywhere
		this.addCommand({
			id: 'review-placeholders',
			name: 'Review Placeholders',
			callback: () => {
				this.showReviewPlaceholdersModal();
			}
		});
		// This adds an editor command that can perform some operation on the current editor instance
		this.addCommand({
			id: 'insert-placeholder',
			name: 'Insert Placeholder',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				console.log(editor.getSelection());
				editor.replaceSelection('((=))');
			}
		});

		// Custom key handlers for interactive fill
		this.registerDomEvent(document, 'click', this.handleEditorClick.bind(this));
		this.registerDomEvent(document, 'keydown', this.handleKeyDown.bind(this));

		// Update the count when the active leaf changes or editor changes
		this.app.workspace.on('active-leaf-change', () => this.updateCountOnStatusBar());
		this.app.workspace.on('editor-change', () => this.updateCountOnStatusBar());

		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));

		// Show Modal on startup if the setting is enabled
		if (this.settings.reviewPlaceholdersOnStart) {
			this.app.workspace.onLayoutReady(async () => {
				await this.showReviewPlaceholdersModal();
			});
		}
	}

	onunload() {
		this.closeInteractiveFill();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// Count placeholders in a given text
	countOccurrences(text: string, word: string): number {
		const regex = new RegExp(/\(\(=\)\)/g)
		const matches = text.match(regex);
		return matches ? matches.length : 0;
	}

	// Update count on the status bar
	async updateCountOnStatusBar() {
		const activeLeaf = this.app.workspace.activeLeaf;
		if (activeLeaf) {
			const view = activeLeaf.view as MarkdownView;
			if (view && view.getViewType() === 'markdown') {
				const editor = view.editor;
				const content = editor.getValue();
				const count = this.countOccurrences(content, '((=))');
				this.statusBarItemEl.setText(`${count} placeholders`);
			} else {
				this.statusBarItemEl.setText('');
			}
		}
	}

	// Handler for highlighting placeholder in editor view
	highlightPlaceholderInEditor() {
		return ViewPlugin.fromClass(class {
			decorations: DecorationSet;

			constructor(view: EditorView) {
				this.decorations = this.buildDecorations(view);
			}

			update(update: ViewUpdate) {
				if (update.docChanged || update.viewportChanged) {
					this.decorations = this.buildDecorations(update.view);
				}
			}

			buildDecorations(view: EditorView) {
				const builder = new RangeSetBuilder<Decoration>();

				// Highlight Placeholder
				for (let { from, to } of view.visibleRanges) {
					let text = view.state.doc.sliceString(from, to);
					let match;
					const regex = /\(\(=\)\)/g;
					while ((match = regex.exec(text)) !== null) {
						const start = from + match.index;
						const end = start + match[0].length;
						builder.add(start, end, Decoration.mark({
							class: 'highlight-placeholder'
						}));
					}
				}

				return builder.finish();
			}
		}, {
			decorations: v => v.decorations
		});
	}

	// Handler for highlighting placeholder in reader view
	highlightPlaceholderInReader(element: HTMLElement, context: MarkdownPostProcessorContext) {
		// Iterate through all the paragraphs in the rendered Markdown
		element.querySelectorAll('p').forEach((paragraph) => {
			// Replace the target string with a custom element
			paragraph.innerHTML = paragraph.innerHTML.replace(/\(\(=\)\)/g, (match) => {
				return `<span class="highlight-placeholder">${match}</span>`;
			});
		});
	}

	//
	// Review Placeholders Modal
	//
	async showReviewPlaceholdersModal() {
		const files = this.app.vault.getMarkdownFiles();
		const results = new Map<string, { title: string, count: number }>();
		let totalCount = 0;

		for (const file of files) {
			const content = await this.app.vault.read(file);
			const count = this.countOccurrences(content, '((=))');
			totalCount += count;
			const title = this.extractTitle(content) || file.basename;
			results.set(file.path, { title, count });
		}

		if (totalCount) {
			new ReviewPlaceholdersModal(this.app, results).open();
		} else {
			new Notice('No placeholders to review, You\'ve caught up!');
		}
	}

	extractTitle(content: string): string | null {
		const titleMatch = content.match(/^# (.+)$/m);
		return titleMatch ? titleMatch[1] : null;
	}

	//
	// Interactive Placeholder Fill 
	//

	handleKeyDown(evt: KeyboardEvent) {
		if (evt.key === 'Escape') {
			this.closeInteractiveFill();
		}
	}
	
	getViewMode(activeLeaf: WorkspaceLeaf) {
		const view = activeLeaf.view;
		if (view instanceof MarkdownView) {
			return view.getMode()
		}
	}

	handleEditorClick(evt: MouseEvent) {
		const target = evt.target as HTMLElement;
		if (target.classList.contains('highlight-placeholder')) {
			if (this.app.workspace.activeLeaf && this.getViewMode(this.app.workspace.activeLeaf) == "preview") {
				new Notice('You are in Preview Mode (Reading Mode). Change to source to edit the placeholder');
				return;
			}
			this.openIteractiveFill(target);
		} else {
			this.closeInteractiveFill();
		}
	}

	openIteractiveFill(target: HTMLElement) {
		// Ensure only one modal is open at a time
		this.closeInteractiveFill();

		// Create a modal dialog with a text input
		const modal = document.createElement('div');
		modal.className = 'interactive-replace-modal';
		modal.innerHTML = `
            <input type="text" id="replacementText" placeholder="Type text and <Enter> or <Esc> to hide">
            <button id="replaceButton">Replace</button>
        `;

		// Calculate modal position near the target element
		const rect = target.getBoundingClientRect();
		const modalTop = rect.bottom + window.scrollY + 3; // Adjust vertical position
		const modalLeft = rect.right + window.scrollX + 3; // Adjust horizontal position
		modal.style.position = 'absolute';
		modal.style.top = `${modalTop}px`;
		modal.style.left = `${modalLeft}px`;

		// Append modal to the document body
		document.body.appendChild(modal);

		// Focus on the input field
		const inputField = modal.querySelector<HTMLInputElement>('#replacementText');
		inputField?.focus();

		// Handle replace button click
		const replaceButton = modal.querySelector<HTMLButtonElement>('#replaceButton');
		replaceButton?.addEventListener('click', () => {
			this.replacePlaceholder(target, inputField?.value);
		});

		// Handle enter key press
		inputField?.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				this.replacePlaceholder(target, inputField?.value);
			}
		});

		// Assign modal to this.modal
		this.modal = modal;
	}

	replacePlaceholder(target: HTMLElement, replacementText?: string) {
		if (replacementText) {
			const currentText = target.innerText;
			const newText = currentText.replace(/\(\(=\)\)/g, replacementText);
			target.innerText = newText;
			console.log(target);
			console.log(target.classList);
			target.classList.remove('highlight-placeholder');
		}
		this.closeInteractiveFill();
	}

	closeInteractiveFill() {
		if (this.modal && this.modal.parentNode) {
			this.modal.parentNode.removeChild(this.modal);
			this.modal = null;
		}
	}

	// CSS
	addCss() {
		const style = document.createElement('style');
		style.textContent = `
			.highlight-placeholder {
				cursor: pointer;
				font-weight: bold;
				color: var(--text-error);
				border: 0.5px solid var(--background-modifier-error);
				padding-bottom: 2px;
			}
			
			.interactive-replace-modal {
				background-color: var(--background-primary);
				color: var(--text-normal);
				border: 2px solid var(--background-modifier-border);
				box-shadow: var(--shadow-elevation-1);
				position: fixed;
				padding: 20px;
				border-radius: 5px;
			}
			.interactive-replace-modal input[type="text"] {
				width: 100%;
				padding: 8px;
				margin-bottom: 10px;
				background-color: var(--background-secondary);
				color: var(--text-normal);
				border: 1px solid var(--background-modifier-border);
			}
			.interactive-replace-modal button {
				padding: 8px 16px;
				background-color: var(--interactive-accent);
				color: white;
				border: none;
				cursor: pointer;
			}
			.interactive-replace-modal button:hover {
				background-color: var(--interactive-accent-hover);
			}
			
			.review-placeholders-table {
				marging: 10px;
			}
		`;
		document.head.append(style);
	}
}

class ReviewPlaceholdersModal extends Modal {
	results: Map<string, { title: string, count: number }>;

	constructor(app: App, results: Map<string, { title: string, count: number }>) {
		super(app);
		this.results = results;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: 'Review Placeholders' });

		const table = contentEl.createEl('table', { cls: 'review-placeholders-table' });
		const headerRow = table.createEl('tr');
		headerRow.createEl('th', { text: 'Note' });
		headerRow.createEl('th', { text: 'Count' });

		this.results.forEach(({ title, count }, path) => {
			if (count >= 1) {
				const row = table.createEl('tr');
				const linkEl = row.createEl('td').createEl('a', {
					text: title,
					href: `obsidian://open?vault=${this.app.vault.getName()}&file=${encodeURIComponent(path)}`
				});
				linkEl.setAttr('target', '_blank');
				row.createEl('td', { text: count.toString() });
			}
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class PlaceholderSettingTab extends PluginSettingTab {
	plugin: PlaceholderPlugin;

	constructor(app: App, plugin: PlaceholderPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Review Placeholders on start-up?')
			.setDesc('Do you want the plugin to prompt all placeholders for your review when obsidian starts up?')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.reviewPlaceholdersOnStart)
				.onChange(async (value) => {
					this.plugin.settings.reviewPlaceholdersOnStart = value;
					await this.plugin.saveSettings();
				}));
	}
}
