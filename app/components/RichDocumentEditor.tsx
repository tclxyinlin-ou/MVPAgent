"use client";

import { useEffect } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import Highlight from "@tiptap/extension-highlight";
import Placeholder from "@tiptap/extension-placeholder";
import { TextStyle } from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import TextAlign from "@tiptap/extension-text-align";
import { Table } from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import { Extension } from "@tiptap/core";

const FONT_SIZES = ["14px", "16px", "18px", "20px", "24px", "28px", "32px"] as const;

const FontSize = Extension.create({
  name: "fontSize",
  addGlobalAttributes() {
    return [
      {
        types: ["textStyle"],
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element) => element.style.fontSize || null,
            renderHTML: (attributes) => {
              if (!attributes.fontSize) {
                return {};
              }

              return {
                style: `font-size: ${attributes.fontSize}`,
              };
            },
          },
        },
      },
    ];
  },
  addCommands() {
    return {
      setFontSize:
        (fontSize: string) =>
        ({ chain }: { chain: () => { setMark: (name: string, attrs?: Record<string, unknown>) => { run: () => boolean } } }) =>
          chain().setMark("textStyle", { fontSize }).run(),
      unsetFontSize:
        () =>
        ({ chain }: { chain: () => { setMark: (name: string, attrs?: Record<string, unknown>) => { removeEmptyTextStyle: () => { run: () => boolean } } } }) =>
          chain().setMark("textStyle", { fontSize: null }).removeEmptyTextStyle().run(),
    } as never;
  },
});

type Props = {
  value: string;
  onChange: (payload: { html: string }) => void;
  disabled?: boolean;
};

function ToolbarButton({
  label,
  active,
  onClick,
  disabled,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`rich-toolbar-button ${active ? "rich-toolbar-button-active" : ""}`}
      onClick={onClick}
      disabled={disabled}
    >
      {label}
    </button>
  );
}

export default function RichDocumentEditor({ value, onChange, disabled }: Props) {
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4] },
      }),
      Underline,
      Link.configure({
        openOnClick: false,
        autolink: true,
      }),
      Highlight,
      Placeholder.configure({
        placeholder: "直接编辑文档内容，支持标题、字号、列表、引用、表格等格式。",
      }),
      TextStyle,
      Color,
      FontSize,
      TextAlign.configure({
        types: ["heading", "paragraph"],
      }),
      Table.configure({
        resizable: false,
      }),
      TableRow,
      TableHeader,
      TableCell,
    ],
    content: value || "<p></p>",
    editable: !disabled,
    onUpdate({ editor: current }) {
      onChange({
        html: current.getHTML(),
      });
    },
  });

  useEffect(() => {
    if (!editor) {
      return;
    }

    if (editor.getHTML() !== value) {
      editor.commands.setContent(value || "<p></p>", { emitUpdate: false });
    }

    editor.setEditable(!disabled);
  }, [editor, value, disabled]);

  if (!editor) {
    return null;
  }

  const currentHeading = (() => {
    if (editor.isActive("heading", { level: 1 })) return "h1";
    if (editor.isActive("heading", { level: 2 })) return "h2";
    if (editor.isActive("heading", { level: 3 })) return "h3";
    if (editor.isActive("heading", { level: 4 })) return "h4";
    return "p";
  })();

  const currentFontSize = (editor.getAttributes("textStyle").fontSize as string) || "";

  return (
    <div className="rich-editor-shell">
      <div className="rich-toolbar">
        <select
          className="rich-select"
          value={currentHeading}
          onChange={(event) => {
            const next = event.target.value;
            if (next === "p") {
              editor.chain().focus().setParagraph().run();
              return;
            }

            editor.chain().focus().toggleHeading({ level: Number(next.slice(1)) as 1 | 2 | 3 | 4 }).run();
          }}
          disabled={disabled}
        >
          <option value="p">正文</option>
          <option value="h1">一级标题</option>
          <option value="h2">二级标题</option>
          <option value="h3">三级标题</option>
          <option value="h4">四级标题</option>
        </select>

        <select
          className="rich-select"
          value={currentFontSize}
          onChange={(event) => {
            const next = event.target.value;
            if (!next) {
              editor.chain().focus().unsetFontSize().run();
              return;
            }
            editor.chain().focus().setFontSize(next).run();
          }}
          disabled={disabled}
        >
          <option value="">默认字号</option>
          {FONT_SIZES.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>

        <ToolbarButton
          label="B"
          active={editor.isActive("bold")}
          onClick={() => editor.chain().focus().toggleBold().run()}
          disabled={disabled}
        />
        <ToolbarButton
          label="I"
          active={editor.isActive("italic")}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          disabled={disabled}
        />
        <ToolbarButton
          label="U"
          active={editor.isActive("underline")}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          disabled={disabled}
        />
        <ToolbarButton
          label="高亮"
          active={editor.isActive("highlight")}
          onClick={() => editor.chain().focus().toggleHighlight().run()}
          disabled={disabled}
        />
        <ToolbarButton
          label="无序"
          active={editor.isActive("bulletList")}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          disabled={disabled}
        />
        <ToolbarButton
          label="有序"
          active={editor.isActive("orderedList")}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          disabled={disabled}
        />
        <ToolbarButton
          label="引用"
          active={editor.isActive("blockquote")}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          disabled={disabled}
        />
        <ToolbarButton
          label="左对齐"
          active={editor.isActive({ textAlign: "left" })}
          onClick={() => editor.chain().focus().setTextAlign("left").run()}
          disabled={disabled}
        />
        <ToolbarButton
          label="居中"
          active={editor.isActive({ textAlign: "center" })}
          onClick={() => editor.chain().focus().setTextAlign("center").run()}
          disabled={disabled}
        />
        <ToolbarButton
          label="右对齐"
          active={editor.isActive({ textAlign: "right" })}
          onClick={() => editor.chain().focus().setTextAlign("right").run()}
          disabled={disabled}
        />
        <ToolbarButton
          label="表格"
          onClick={() =>
            editor
              .chain()
              .focus()
              .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
              .run()
          }
          disabled={disabled}
        />
        <ToolbarButton
          label="清格式"
          onClick={() =>
            editor.chain().focus().clearNodes().unsetAllMarks().unsetFontSize().run()
          }
          disabled={disabled}
        />
      </div>

      <EditorContent editor={editor} className="rich-editor-content" />
    </div>
  );
}
