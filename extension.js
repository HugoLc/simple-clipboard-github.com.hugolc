/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should ha      // Adicionar a caixa principal ao item de menu
      menuItem.add_child(mainBox);

      // Conectar evento de clique para colar o conteúdo
      menuItem.connect("activate", () => {
        this._pasteItem(item.content, item.isText);
        this.menu.close();
      });

      section.addMenuItem(menuItem);
    }d a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Clutter from "gi://Clutter";
import Meta from "gi://Meta";
import Shell from "gi://Shell";
import GdkPixbuf from 'gi://GdkPixbuf';
import Cogl from 'gi://Cogl';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const MAX_HISTORY_ITEMS = 50;
const HISTORY_STORAGE_FILE = "clipboard-history.json";
const CLIPBOARD_SAVE_TIMEOUT = 500; // ms para aguardar antes de salvar no histórico

// Classe para gerenciar os itens do clipboard
const ClipboardItem = class {
  constructor(content, isText, timestamp = Date.now(), isFavorite = false) {
    this.content = content;
    this.isText = isText;
    this.timestamp = timestamp;
    this.isFavorite = isFavorite;
  }

  equals(other) {
    return this.isText === other.isText && this.content === other.content;
  }
};

const ClipboardIndicator = GObject.registerClass(
  class ClipboardIndicator extends PanelMenu.Button {
    _init(extensionPath) {
      super._init(0.0, _("Histórico do Clipboard"));

      this._extensionPath = extensionPath;
      this._clipboardHistory = [];
      this._favoriteItems = [];
      this._clipboard = St.Clipboard.get_default();
      this._selection = Shell.Global.get().get_display().get_selection();
      this._selectionOwnerChangedId = 0;
      this._historyStoragePath = GLib.build_filenamev([
        GLib.get_user_data_dir(),
        "gnome-shell",
        "extensions",
        "simple-clipboard@github.com.hugolc",
        HISTORY_STORAGE_FILE,
      ]);
      this._previousText = "";
      this._previousImage = null;
      this._timeoutId = 0;

      // Ícone do clipboard na barra de status
      this.add_child(
        new St.Icon({
          icon_name: "edit-paste-symbolic",
          style_class: "system-status-icon",
        })
      );

      // Carregar histórico salvo
      this._loadHistory();

      // Seção para itens favoritos
      this._favoritesSection = new PopupMenu.PopupMenuSection();
      this.menu.addMenuItem(this._favoritesSection);

      // Adicionar separador entre favoritos e histórico normal
      this.menu.addMenuItem(
        new PopupMenu.PopupSeparatorMenuItem(_("Histórico"))
      ); // Criar um ScrollView para histórico limitado em altura
      let historyScrollSection = new PopupMenu.PopupMenuSection();
      let historyScrollBox = new St.ScrollView({
        style_class: "clipboard-history-scrollbox",
        hscrollbar_policy: St.PolicyType.NEVER,
        vscrollbar_policy: St.PolicyType.AUTOMATIC,
        overlay_scrollbars: true,
      });
      // Adicionar box vertical dentro do scroll para os itens
      let historyVerticalBox = new St.BoxLayout({
        vertical: true,
      });
      historyScrollBox.set_child(historyVerticalBox);

      // Criar menu section para conter os itens
      this._historySection = new PopupMenu.PopupMenuSection();
      historyVerticalBox.add_child(this._historySection.actor);

      // Adicionar o scroll à seção principal
      historyScrollSection.actor.add_child(historyScrollBox);
      this.menu.addMenuItem(historyScrollSection);

      // Footer com opções adicionaisv
      this._addFooterOptions();

      // Atualizar o menu
      this._updateMenu();

      // Conectar ao evento de mudança no clipboard
      this._connectToClipboard();
    }

    _connectToClipboard() {
      this._selectionOwnerChangedId = this._selection.connect(
        "owner-changed",
        (selection, selectionType, selectionSource) => {
          if (selectionType === Meta.SelectionType.SELECTION_CLIPBOARD) {
            // Adicionar um pequeno atraso para evitar múltiplas capturas
            if (this._timeoutId > 0) {
              GLib.source_remove(this._timeoutId);
              this._timeoutId = 0;
            }

            this._timeoutId = GLib.timeout_add(
              GLib.PRIORITY_DEFAULT,
              CLIPBOARD_SAVE_TIMEOUT,
              () => {
                this._checkClipboardContents();
                this._timeoutId = 0;
                return GLib.SOURCE_REMOVE;
              }
            );
          }
        }
      );
    }

    _checkClipboardContents() {
      // Verificar conteúdo de texto
      this._clipboard.get_text(
        St.ClipboardType.CLIPBOARD,
        (clipboard, text) => {
          if (text && text !== this._previousText && text.trim().length > 0) {
            this._previousText = text;
            this._addToHistory(text, true);
          }
        }
      );

      // Verificar conteúdo de imagem
      this._clipboard.get_content(
        St.ClipboardType.CLIPBOARD,
        "image/png",
        (clipboard, bytes) => {
          if (bytes && bytes.get_size() > 0) {
            try {
              // Criar um stream a partir dos bytes
              let stream = Gio.MemoryInputStream.new_from_bytes(bytes);

              // Carregar como pixbuf
              let pixbuf = GdkPixbuf.Pixbuf.new_from_stream(stream, null);

              if (pixbuf) {
                // Salvar dimensões originais da imagem
                let width = pixbuf.get_width();
                let height = pixbuf.get_height();

                // Converter a imagem para base64 sem redimensionar
                // Isso mantém o tamanho original para colagem posterior
                let base64Data = this._pixbufToBase64(pixbuf);

                // Não salvamos na memória exatamente o mesmo pixbuf,
                // mas podemos verificar se o tamanho dos dados são iguais
                // para evitar duplicações no histórico
                let imageContent = `data:image/png;base64,${base64Data}`;

                // Adicionar ao histórico se for diferente da anterior
                if (
                  !this._previousImage ||
                  this._previousImage !== imageContent
                ) {
                  this._previousImage = imageContent;
                  this._addToHistory(imageContent, false);
                }
              }
            } catch (e) {
              logError(e, "Falha ao processar imagem do clipboard");
            }
          }
        }
      );
    }

    _pixbufToBase64(pixbuf) {
      if (!pixbuf) return null;

      try {
        // Use o GdkPixbuf para salvar a imagem como PNG em um buffer de memória
        let [success, buffer] = pixbuf.save_to_bufferv("png", [], []);
        if (!success) return null;

        // Converter o buffer para base64
        return GLib.base64_encode(buffer);
      } catch (e) {
        logError(e, "Falha ao converter pixbuf para base64");
        return null;
      }
    }

    _addToHistory(content, isText) {
      const newItem = new ClipboardItem(content, isText);

      // Verificar se o item já existe na lista
      const existingIndex = this._clipboardHistory.findIndex((item) =>
        item.equals(newItem)
      );

      // Se o item existir, preservar seu status de favorito
      if (existingIndex !== -1) {
        const existingItem = this._clipboardHistory[existingIndex];
        // Preservar o status de favorito do item existente
        newItem.isFavorite = existingItem.isFavorite;
        // Remover o item existente
        this._clipboardHistory.splice(existingIndex, 1);
      }

      // Adicionar novo item ao início
      this._clipboardHistory.unshift(newItem);

      // Manter apenas MAX_HISTORY_ITEMS no histórico
      if (this._clipboardHistory.length > MAX_HISTORY_ITEMS) {
        // Vamos remover apenas itens não favoritados que excedem o limite
        let nonFavorites = this._clipboardHistory.filter(
          (item) => !item.isFavorite
        );
        let toRemove = this._clipboardHistory.length - MAX_HISTORY_ITEMS;

        if (toRemove > 0 && nonFavorites.length > 0) {
          // Começamos removendo do final da lista
          for (
            let i = this._clipboardHistory.length - 1;
            i >= 0 && toRemove > 0;
            i--
          ) {
            if (!this._clipboardHistory[i].isFavorite) {
              this._clipboardHistory.splice(i, 1);
              toRemove--;
            }
          }
        }
      }

      // Atualizar menu e salvar
      this._updateMenu();
      this._saveHistory();
    }

    _toggleFavorite(item) {
      item.isFavorite = !item.isFavorite;
      this._updateMenu();
      this._saveHistory();
    }

    _pasteItem(content, isText) {
      if (isText) {
        this._clipboard.set_text(St.ClipboardType.CLIPBOARD, content);
        this._clipboard.set_text(St.ClipboardType.PRIMARY, content);
      } else {
        // Para imagens, precisamos converter o base64 de volta para pixbuf
        if (content.startsWith("data:image/png;base64,")) {
          try {
            // Extrair a parte base64 da string
            let base64Data = content.replace("data:image/png;base64,", "");

            // Converter base64 para bytes
            let bytes = GLib.base64_decode(base64Data);

            // Criar um stream a partir dos bytes
            let stream = Gio.MemoryInputStream.new_from_bytes(
              new GLib.Bytes(bytes)
            );

            // Carregar como pixbuf
            let pixbuf = GdkPixbuf.Pixbuf.new_from_stream(stream, null);

            // Colocar a imagem no clipboard
            // Nota: isso é importante: precisamos usar bytes em vez de pixbuf direto
            let [success, buffer] = pixbuf.save_to_bufferv("png", [], []);
            if (success) {
              let bytes = GLib.Bytes.new(buffer);
              this._clipboard.set_content(
                St.ClipboardType.CLIPBOARD,
                "image/png",
                bytes
              );
            }
          } catch (e) {
            logError(e, "Falha ao colar imagem");
          }
        }
      }

      // Simular Ctrl+V para colar automaticamente
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
        this._simulateKeyPress();
        return GLib.SOURCE_REMOVE;
      });
    }

    _simulateKeyPress() {
      // Simular pressionamento de Ctrl+V usando o Clutter.VirtualInputDevice
      let backend = Clutter.get_default_backend();
      if (!backend.get_default_seat) {
        logError(new Error("Backend não suporta get_default_seat"));
        return;
      }

      let seat = backend.get_default_seat();
      if (!seat.create_virtual_device) {
        logError(new Error("Seat não suporta create_virtual_device"));
        return;
      }

      let virtualDevice = seat.create_virtual_device(
        Clutter.InputDeviceType.KEYBOARD_DEVICE
      );
      if (!virtualDevice) {
        logError(new Error("Não foi possível criar o dispositivo virtual"));
        return;
      }

      // Primeiro liberamos qualquer ctrl pressionado para evitar problemas
      virtualDevice.notify_keyval(
        Clutter.get_current_event_time(),
        Clutter.KEY_Control_L,
        Clutter.KeyState.RELEASED
      );

      // Agora simulamos a sequência ctrl+v
      // Pressiona CTRL
      virtualDevice.notify_keyval(
        Clutter.get_current_event_time(),
        Clutter.KEY_Control_L,
        Clutter.KeyState.PRESSED
      );

      // Pressiona V
      virtualDevice.notify_keyval(
        Clutter.get_current_event_time(),
        Clutter.KEY_v,
        Clutter.KeyState.PRESSED
      );

      // Solta V
      virtualDevice.notify_keyval(
        Clutter.get_current_event_time(),
        Clutter.KEY_v,
        Clutter.KeyState.RELEASED
      );

      // Solta CTRL
      virtualDevice.notify_keyval(
        Clutter.get_current_event_time(),
        Clutter.KEY_Control_L,
        Clutter.KeyState.RELEASED
      );

      // Garantir que a aplicação atual receba o evento de teclado
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
        Main.findModal(null)?.popModal();
        return GLib.SOURCE_REMOVE;
      });
    }

    _updateMenu() {
      // Limpar menus existentes
      this._favoritesSection.removeAll();
      this._historySection.removeAll();

      // Adicionar itens favoritos
      const favoriteItems = this._clipboardHistory.filter(
        (item) => item.isFavorite
      );
      if (favoriteItems.length > 0) {
        favoriteItems.forEach((item) => {
          this._addMenuItem(item, this._favoritesSection, true);
        });
      } else {
        // Mostrar mensagem se não houver favoritos
        let emptyMenuItem = new PopupMenu.PopupMenuItem(_("Nenhum favorito"));
        emptyMenuItem.setSensitive(false);
        this._favoritesSection.addMenuItem(emptyMenuItem);
      }

      // Adicionar itens de histórico (excluindo favoritos)
      const historyItems = this._clipboardHistory.filter(
        (item) => !item.isFavorite
      );
      if (historyItems.length > 0) {
        historyItems.forEach((item) => {
          this._addMenuItem(item, this._historySection, false);
        });
      } else {
        // Mostrar mensagem se não houver histórico
        let emptyMenuItem = new PopupMenu.PopupMenuItem(_("Histórico vazio"));
        emptyMenuItem.setSensitive(false);
        this._historySection.addMenuItem(emptyMenuItem);
      }
    }
    _addMenuItem(item, section, isFavorite) {
      // Criar o item de menu base que conterá todos os elementos
      let menuItem = new PopupMenu.PopupBaseMenuItem();
      
      // Layout principal que organize todos os elementos
      let mainBox = new St.BoxLayout({
        vertical: false,
        x_expand: true,
      });
      
      // Adicionar ícone de favorito (agora primeiro elemento)
      let favButton = new St.Button({
        style_class: "clipboard-favorite-button",
        x_expand: false,
        y_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
      });

      let favIcon = new St.Icon({
        icon_name: item.isFavorite
          ? "starred-symbolic"
          : "non-starred-symbolic",
        style_class: "popup-menu-icon",
      });

      favButton.set_child(favIcon);
      favButton.connect("clicked", () => {
        this._toggleFavorite(item);
        return Clutter.EVENT_STOP;
      });

      // Adicionar o botão de favorito como primeiro elemento
      mainBox.add_child(favButton);
      
      // Adicionar o conteúdo (texto ou imagem) após o ícone de favorito
      if (item.isText) {
        // Remover espaços no início e fim para exibição
        let trimmedContent = item.content.trim();

        // Truncar o texto para exibição
        let displayText =
          trimmedContent.length > 50
            ? trimmedContent.substring(0, 47) + "..."
            : trimmedContent;
        displayText = displayText.replace(/\n/g, " ");

        // Criar label para o texto
        let label = new St.Label({
          text: displayText,
          x_expand: true,
          x_align: Clutter.ActorAlign.START,
          y_align: Clutter.ActorAlign.CENTER,
        });

        mainBox.add_child(label);
      } else {
        // Para imagens, criar uma visualização em miniatura
        let imageBox = new St.BoxLayout({ 
          vertical: false,
          x_expand: true,
          x_align: Clutter.ActorAlign.START,
        });

        if (item.content.startsWith("data:image/png;base64,")) {
          try {
            // Preparar dados de imagem
            let base64Data = item.content.replace("data:image/png;base64,", "");
            let imageData = GLib.base64_decode(base64Data);

            // Criar arquivo temporário para a miniatura
            let [tempFile, tempPath] = Gio.File.new_tmp(
              "clipboard-thumbnail-XXXXXX.png"
            );
            tempFile.replace_contents(
              imageData,
              null,
              false,
              Gio.FileCreateFlags.REPLACE_DESTINATION,
              null
            );

            // Criar um GIcon a partir do arquivo
            let gicon = Gio.FileIcon.new(tempFile);

            // Criar miniatura de imagem
            let imageIcon = new St.Icon({
              gicon: gicon,
              icon_size: 48, // Tamanho razoável para menu
              style_class: "clipboard-image-preview",
            });

            imageBox.add_child(imageIcon);

            // Adicionar evento de limpeza quando o menu fechar
            this.menu.connect("open-state-changed", (menu, isOpen) => {
              if (!isOpen) {
                try {
                  // Apagar arquivos temporários quando fechar
                  tempFile.delete(null);
                } catch (e) {
                  // Ignorar erros ao tentar apagar arquivo temporário
                }
              }
            });
          } catch (e) {
            logError(e, "Falha ao exibir miniatura da imagem");
            // Fallback para ícone padrão
            let icon = new St.Icon({
              icon_name: "insert-image-symbolic",
              style_class: "popup-menu-icon",
            });
            imageBox.add_child(icon);
          }
        } else {
          // Fallback para ícone de imagem
          let icon = new St.Icon({
            icon_name: "insert-image-symbolic",
            style_class: "popup-menu-icon",
          });
          imageBox.add_child(icon);
        }
        
        mainBox.add_child(imageBox);
      }
      
      // Adicionar a caixa principal ao item de menu
      menuItem.add_child(mainBox);

      // Conectar evento de clique para colar o conteúdo
      menuItem.connect("activate", () => {
        this._pasteItem(item.content, item.isText);
        this.menu.close();
      });

      section.addMenuItem(menuItem);
    }

    _addFooterOptions() {
      // Separador antes das opções de rodapé
      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

      // Opção para limpar histórico
      let clearMenuItem = new PopupMenu.PopupMenuItem(_("Limpar Histórico"));
      clearMenuItem.connect("activate", () => {
        // Remover apenas itens não favoritos
        this._clipboardHistory = this._clipboardHistory.filter(
          (item) => item.isFavorite
        );
        this._updateMenu();
        this._saveHistory();
      });
      this.menu.addMenuItem(clearMenuItem);

      // Opção para limpar tudo (incluindo favoritos)
      let clearAllMenuItem = new PopupMenu.PopupMenuItem(
        _("Limpar Tudo (incluindo favoritos)")
      );
      clearAllMenuItem.connect("activate", () => {
        this._clipboardHistory = [];
        this._updateMenu();
        this._saveHistory();
      });
      this.menu.addMenuItem(clearAllMenuItem);
    }

    _loadHistory() {
      try {
        // Verificar se o arquivo existe
        let file = Gio.File.new_for_path(this._historyStoragePath);
        if (!file.query_exists(null)) {
          this._clipboardHistory = [];
          return;
        }

        // Ler e analisar o arquivo JSON
        let [success, contents] = file.load_contents(null);
        if (success) {
          let jsonData = JSON.parse(new TextDecoder().decode(contents));
          this._clipboardHistory = jsonData.map(
            (item) =>
              new ClipboardItem(
                item.content,
                item.isText,
                item.timestamp,
                item.isFavorite
              )
          );
        }
      } catch (e) {
        logError(e, "Falha ao carregar o histórico do clipboard");
        this._clipboardHistory = [];
      }
    }

    _saveHistory() {
      try {
        // Preparar o diretório para armazenamento
        let file = Gio.File.new_for_path(this._historyStoragePath);
        let parentDir = file.get_parent();

        if (!parentDir.query_exists(null)) {
          parentDir.make_directory_with_parents(null);
        }

        // Converter para JSON e salvar
        let jsonData = JSON.stringify(this._clipboardHistory);
        let bytes = new TextEncoder().encode(jsonData);

        let [success, tag] = file.replace_contents(
          bytes,
          null,
          false,
          Gio.FileCreateFlags.REPLACE_DESTINATION,
          null
        );
      } catch (e) {
        logError(e, "Falha ao salvar o histórico do clipboard");
      }
    }
    destroy() {
      // Desconectar monitores e limpar
      if (this._selectionOwnerChangedId > 0) {
        this._selection.disconnect(this._selectionOwnerChangedId);
        this._selectionOwnerChangedId = 0;
      }

      if (this._timeoutId > 0) {
        GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
      }

      // Salvar histórico antes de destruir
      this._saveHistory();

      super.destroy();
    }
  }
);

export default class SimpleClipboardExtension extends Extension {
  enable() {
    // Inicializar as configurações
    this._settings = this.getSettings();

    this._indicator = new ClipboardIndicator(this.path);
    Main.panel.addToStatusArea(this.uuid, this._indicator);

    // Adicionar atalho de teclado Super+V
    this._addKeybinding();
  }

  _addKeybinding() {
    // Adicionar atalho Super+V para abrir o painel do clipboard
    Main.wm.addKeybinding(
      "clipboard-shortcut",
      this._settings,
      Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
      Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
      () => {
        // Alternar a visibilidade do menu
        if (this._indicator.menu.isOpen) {
          this._indicator.menu.close();
        } else {
          this._indicator.menu.open();
        }
      }
    );
  }

  disable() {
    // Remover atalho de teclado
    Main.wm.removeKeybinding("clipboard-shortcut");

    this._indicator.destroy();
    this._indicator = null;

    this._settings = null;
  }
}
