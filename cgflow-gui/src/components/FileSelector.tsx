import { useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  useUploadedFiles,
  formatFileSize,
  formatFileDate,
  type FieldType,
  type FileType,
  type UploadedFile,
} from '@/hooks/useUploadedFiles';
import {
  FileUp,
  Check,
  ChevronDown,
  Cloud,
  HardDrive,
  Loader2,
  Trash2,
  Clock,
} from 'lucide-react';
import { normalizeRunnerPathInput } from '@/lib/webMode';

interface FileSelectorProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onContentLoaded?: (content: string) => void;
  fieldType: FieldType;
  fileType: FileType;
  accept: string;
  placeholder?: string;
  optional?: boolean;
  // For local file selection (IPC or web)
  onSelectLocal: () => Promise<string | null>;
  onReadLocalContent?: (path: string) => Promise<string>;
  prepareFileForUpload?: (file: File) => Promise<{ file: File; content: string }>;
  disableLocalPicker?: boolean;
  pathInputMode?: boolean;
  pathInputPlaceholder?: string;
}

export default function FileSelector({
  label,
  value,
  onChange,
  onContentLoaded,
  fieldType,
  fileType,
  accept,
  placeholder = 'Select a file...',
  optional = false,
  onSelectLocal,
  onReadLocalContent,
  prepareFileForUpload,
  disableLocalPicker = false,
  pathInputMode = false,
  pathInputPlaceholder,
}: FileSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0, width: 0 });

  // Update dropdown position when opening
  useEffect(() => {
    if (isOpen && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setDropdownPosition({
        top: rect.bottom + 8, // 8px gap (mt-2)
        left: rect.left,
        width: rect.width,
      });
    }
  }, [isOpen]);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!isOpen) return;
    
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        // Check if click is inside the portal dropdown
        const dropdown = document.getElementById('file-selector-dropdown');
        if (dropdown && dropdown.contains(e.target as Node)) return;
        setIsOpen(false);
      }
    };
    
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);
  
  // Get previously uploaded files for this field type
  const { files, uploadFile, getFileContent, deleteFile, isAvailable } = useUploadedFiles(fieldType);

  // Handle selecting a previously uploaded file
  const handleSelectUploadedFile = useCallback(async (file: UploadedFile) => {
    setIsOpen(false);

    if (!file.url) return;

    const content = await getFileContent(file);
    if (!content) return;

    if (prepareFileForUpload) {
      const prepared = await prepareFileForUpload(new File([content], file.name, { type: 'chemical/x-pdb' }));
      if (prepared.file !== undefined && prepared.file.name !== file.name) {
        const uploaded = await uploadFile(prepared.file, fieldType, fileType);
        if (uploaded) {
          onChange(`convex://${uploaded._id}::${prepared.file.name}`);
          onContentLoaded?.(prepared.content);
          return;
        }
      }
    }

    // Use the file URL as the path (will be recognized as a Convex file)
    onChange(`convex://${file._id}::${file.name}`);
    onContentLoaded?.(content);
  }, [fieldType, fileType, getFileContent, onChange, onContentLoaded, prepareFileForUpload, uploadFile]);

  // Handle selecting a local file
  const handleSelectLocal = useCallback(async () => {
    setIsOpen(false);
    const path = await onSelectLocal();
    if (path) {
      onChange(path);
      
      // Load content if callback provided
      if (onContentLoaded && onReadLocalContent) {
        const content = await onReadLocalContent(path);
        if (content) {
          onContentLoaded(content);
        }
      }
    }
  }, [onSelectLocal, onChange, onContentLoaded, onReadLocalContent]);

  // Handle uploading a new file to Convex
  const handleUploadNew = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    try {
      const prepared = prepareFileForUpload
        ? await prepareFileForUpload(file)
        : { file, content: await file.text() };
      const uploaded = await uploadFile(prepared.file, fieldType, fileType);
      if (uploaded) {
        // The file list will auto-update, select it
        onChange(`convex://${uploaded._id}::${prepared.file.name}`);
        
        // Load content if callback provided
        if (onContentLoaded) {
          onContentLoaded(prepared.content);
        }
      }
    } catch (error) {
      console.error('Failed to upload file:', error);
    } finally {
      setIsUploading(false);
      setIsOpen(false);
      // Reset input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }, [uploadFile, fieldType, fileType, onChange, onContentLoaded, prepareFileForUpload]);

  // Handle deleting an uploaded file
  const handleDelete = useCallback(async (e: React.MouseEvent, fileId: UploadedFile['_id']) => {
    e.stopPropagation();
    await deleteFile(fileId);
  }, [deleteFile]);

  // Get display value
  const displayValue = value
    ? value.startsWith('convex://')
      ? value.split('::')[1] || 'Uploaded file'
      : pathInputMode
        ? value
        : value.split('/').pop() || value
    : '';

  const inputValue = pathInputMode ? value : displayValue;
  const inputPlaceholder = pathInputPlaceholder ?? placeholder;

  const isConvexFile = value.startsWith('convex://');

  useEffect(() => {
    if (!pathInputMode || !value || !onReadLocalContent || !onContentLoaded) return;
    if (value.startsWith('convex://') || value.startsWith('web://')) return;

    const trimmedPath = normalizeRunnerPathInput(value);
    if (!trimmedPath) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const content = await onReadLocalContent(trimmedPath);
          if (!cancelled && content) {
            onContentLoaded(content);
          }
        } catch {
          // Path may be incomplete or unavailable until the runner can read it.
        }
      })();
    }, 400);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pathInputMode, value, onReadLocalContent, onContentLoaded]);

  return (
    <div className="space-y-1">
      <Label className="text-xs font-medium text-muted-foreground">
        {label}
        {optional && <span className="ml-1 text-muted-foreground/60">(optional)</span>}
      </Label>
      
      <div ref={containerRef} className="relative">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Input
              value={inputValue}
              onChange={(e) => onChange(e.target.value)}
              onBlur={() => {
                if (!pathInputMode) return;
                const trimmed = normalizeRunnerPathInput(value);
                if (trimmed !== value) {
                  onChange(trimmed);
                }
              }}
              placeholder={inputPlaceholder}
              className="h-8 pr-8"
            />
            {isConvexFile && (
              <Cloud className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            )}
            {!isConvexFile && value && (
              <HardDrive className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            )}
          </div>

          <Button
            variant="outline"
            size="icon"
            onClick={() => setIsOpen(!isOpen)}
            className="h-8 w-8 shrink-0"
          >
            {isUploading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ChevronDown className={`h-4 w-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
            )}
          </Button>

          {!disableLocalPicker ? (
            <Button
              variant="outline"
              size="icon"
              onClick={handleSelectLocal}
              className="h-8 w-8 shrink-0"
              title="Select from local filesystem"
            >
              <FileUp className="h-4 w-4" />
            </Button>
          ) : null}
        </div>

        {isOpen && createPortal(
          <div
            id="file-selector-dropdown"
            className="fixed overflow-hidden rounded-lg border border-border bg-card shadow-lg shadow-black/20"
            style={{
              top: dropdownPosition.top,
              left: dropdownPosition.left,
              width: dropdownPosition.width,
              zIndex: 9999,
            }}
          >
            <div className="border-b border-border px-3 py-2">
              <p className="text-sm font-medium text-foreground">
                {isAvailable ? 'Cloud Files' : 'Cloud Storage Unavailable'}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {isAvailable ? 'Pick a previously uploaded file or add a new one.' : 'Use the local file picker until Convex is connected.'}
              </p>
            </div>

            {isAvailable && (
              <>
                <ScrollArea className="max-h-56">
                  {files && files.length > 0 ? (
                    <div className="p-1">
                      {files.map((file) => (
                        <button
                          key={file._id}
                          onClick={() => void handleSelectUploadedFile(file)}
                          className="flex w-full items-start justify-between gap-3 rounded-md px-3 py-2 text-left hover:bg-muted/60"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <Cloud className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                              <span className="truncate text-sm font-medium">{file.name}</span>
                              {value.includes(file._id) && <Check className="h-3.5 w-3.5 shrink-0 text-accent" />}
                            </div>
                            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                              <span>{formatFileSize(file.size)}</span>
                              <span>•</span>
                              <Clock className="h-3 w-3" />
                              <span>{formatFileDate(file.createdAt)}</span>
                            </div>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={(e) => void handleDelete(e, file._id)}
                            title="Delete uploaded file"
                          >
                            <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                          </Button>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="px-3 py-4 text-sm text-muted-foreground">No files uploaded yet.</div>
                  )}
                </ScrollArea>

                <div className="border-t border-border p-2">
                  <label className="block">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept={accept}
                      onChange={handleUploadNew}
                      className="hidden"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full justify-center"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={isUploading}
                    >
                      {isUploading ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Cloud className="mr-2 h-4 w-4" />
                      )}
                      Upload to Cloud
                    </Button>
                  </label>
                </div>
              </>
            )}

            {!isAvailable && (
              <div className="px-3 py-4 text-sm text-muted-foreground">
                Cloud-backed file storage is not available in this session.
              </div>
            )}
          </div>,
          document.body
        )}
      </div>

      {pathInputMode ? (
        <p className="text-[11px] text-muted-foreground">
          Type a path accessible to the local runner on this machine.
        </p>
      ) : null}

      {!pathInputMode && value ? (
        <div className="flex items-center gap-2">
          <Badge 
            variant="secondary" 
            className="text-[10px]"
          >
            {isConvexFile ? (
              <>
                <Cloud className="h-3 w-3 mr-1" />
                Cloud file
              </>
            ) : (
              <>
                <HardDrive className="h-3 w-3 mr-1" />
                Local file
              </>
            )}
          </Badge>
        </div>
      ) : null}
    </div>
  );
}
