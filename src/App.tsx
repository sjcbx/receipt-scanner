import React, { useState, useRef, useEffect } from 'react';
import { Camera, Check, Loader2, Download, RefreshCw, Image as ImageIcon, Clock, TrendingUp, ArrowDownAZ, Cloud, CloudOff } from 'lucide-react';
import Tesseract from 'tesseract.js';
import { doc, setDoc, onSnapshot } from 'firebase/firestore';
import { db } from './firebase';
import DatePicker from 'react-datepicker';
import 'react-datepicker/dist/react-datepicker.css';
import { parse, format, isValid } from 'date-fns';

interface CompanyStat {
  name: string;
  lastUsed: number;
  count: number;
}

const useCompanies = () => {
  const [companies, setCompanies] = useState<CompanyStat[]>([]);
  const [sortMode, setSortMode] = useState<'recent' | 'frequent' | 'alphabetical'>('recent');
  const [syncPin, setSyncPin] = useState<string>('');
  const [isSyncing, setIsSyncing] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem('receipt-companies');
      if (stored) {
        setCompanies(JSON.parse(stored));
      }
      const storedPin = localStorage.getItem('receipt-sync-pin');
      if (storedPin) {
        setSyncPin(storedPin);
      }
    } catch (e) {
      console.error("Failed to load companies", e);
    }
  }, []);

  useEffect(() => {
    if (!syncPin || syncPin.length !== 6) return;
    
    setIsSyncing(true);
    const unsub = onSnapshot(doc(db, 'companyLists', syncPin), (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        if (data.companies) {
          setCompanies(data.companies);
          localStorage.setItem('receipt-companies', JSON.stringify(data.companies));
        }
      } else {
        // If the cloud document doesn't exist yet, push our local companies up to initialize it
        setCompanies(prev => {
          if (prev.length > 0) {
            setDoc(doc(db, 'companyLists', syncPin), {
              companies: prev,
              updatedAt: Date.now()
            }).catch(err => console.error("Failed to initialize cloud sync:", err));
          }
          return prev;
        });
      }
      setIsSyncing(false);
    }, (err) => {
      console.error("Sync error:", err);
      setIsSyncing(false);
    });

    return () => unsub();
  }, [syncPin]);

  const updatePin = (newPin: string) => {
    setSyncPin(newPin);
    if (newPin && newPin.length === 6) {
      localStorage.setItem('receipt-sync-pin', newPin);
    } else {
      localStorage.removeItem('receipt-sync-pin');
    }
  };

  const addCompany = async (name: string) => {
    const cleanName = name.trim();
    if (!cleanName) return;
    
    setCompanies(prev => {
      const existing = prev.find(c => c.name.toLowerCase() === cleanName.toLowerCase());
      let newCompanies: CompanyStat[];
      if (existing) {
        newCompanies = prev.map(c => c.name.toLowerCase() === cleanName.toLowerCase() 
          ? { ...c, name: cleanName, lastUsed: Date.now(), count: c.count + 1 } 
          : c);
      } else {
        newCompanies = [...prev, { name: cleanName, lastUsed: Date.now(), count: 1 }];
      }
      
      try {
        localStorage.setItem('receipt-companies', JSON.stringify(newCompanies));
      } catch (e) {
        console.error("Failed to save companies", e);
      }

      if (syncPin && syncPin.length === 6) {
        // Push the newly calculated list to Firestore
        setDoc(doc(db, 'companyLists', syncPin), {
          companies: newCompanies,
          updatedAt: Date.now()
        }).catch(err => {
          console.error("Failed to sync to cloud:", err);
        });
      }

      return newCompanies;
    });
  };

  const sortedCompanies = [...companies].sort((a, b) => {
    if (sortMode === 'recent') return b.lastUsed - a.lastUsed;
    if (sortMode === 'frequent') return b.count - a.count;
    return a.name.localeCompare(b.name);
  });

  return { companies: sortedCompanies, addCompany, sortMode, setSortMode, syncPin, updatePin, isSyncing };
};

const compressImage = (file: File | Blob, maxWidth = 2048, quality = 0.95): Promise<Blob> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.src = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let width = img.width;
      let height = img.height;

      if (width > maxWidth) {
        height = Math.round((height * maxWidth) / width);
        width = maxWidth;
      }

      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error("No canvas context"));
      
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Canvas to Blob failed"));
      }, 'image/jpeg', quality);
    };
    img.onerror = reject;
  });
};

const preprocessImageForOCR = async (blob: Blob): Promise<Blob> => {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return resolve(blob);
      
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;
      
      // Convert to grayscale and increase contrast to help OCR
      const contrast = 1.3; // 30% contrast increase
      const intercept = 128 * (1 - contrast);
      
      for (let i = 0; i < data.length; i += 4) {
        const avg = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        let color = avg * contrast + intercept;
        color = Math.max(0, Math.min(255, color));
        
        data[i] = color;
        data[i + 1] = color;
        data[i + 2] = color;
      }
      
      ctx.putImageData(imageData, 0, 0);
      canvas.toBlob((newBlob) => {
        resolve(newBlob || blob);
      }, 'image/jpeg', 0.95);
    };
    img.onerror = () => resolve(blob);
    img.src = URL.createObjectURL(blob);
  });
};

const getFilenameFromTesseract = async (blob: Blob, onProgress: (msg: string) => void): Promise<{storeName: string, dateStr: string}> => {
  try {
    onProgress("Initializing OCR engine...");
    const result = await Tesseract.recognize(blob, 'eng', {
      logger: m => {
        if (m.status === 'recognizing text') {
          onProgress(`Recognizing text... ${Math.round(m.progress * 100)}%`);
        } else {
          onProgress(`Loading OCR engine...`);
        }
      }
    });
    
    const text = result.data.text;
    onProgress("Parsing receipt data...");

    // 1. Find Company Name (Top of receipt)
    const lines = text.split('\n')
      .map(l => l.trim())
      .filter(l => {
        if (l.length < 4) return false;
        
        // Must contain a word of at least 3 letters
        if (!/[a-zA-Z]{3,}/.test(l)) return false;
        
        // Calculate ratio of letters to total characters
        const letterCount = (l.match(/[a-zA-Z]/g) || []).length;
        if (letterCount / l.length < 0.4) return false;
        
        // Reject if average word length is too small (filters out logo noise like "A p e J e S H")
        const words = l.split(/\s+/).filter(w => /[a-zA-Z]/.test(w));
        if (words.length > 0) {
           const avgWordLength = words.reduce((sum, w) => sum + w.length, 0) / words.length;
           if (avgWordLength < 2.5) return false;
        }
        
        // Reject common non-store words that might appear at the top
        const lower = l.toLowerCase();
        if (lower.includes('receipt') || lower.includes('welcome') || lower.includes('customer') || lower.includes('duplicate')) {
           return false;
        }
        
        return true;
      });

    let storeName = "Receipt";
    if (lines.length > 0) {
      // Take the first valid line, replace non-alphanumeric with hyphens
      storeName = lines[0].replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').substring(0, 30);
      // Capitalize first letter of each word for cleaner look
      storeName = storeName.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('-');
    }

    // 2. Find Date (Format: DD-MM-YYYY)
    const dateRegexes = [
      // Format: DD/MM/YYYY or MM/DD/YYYY
      { regex: /(?:^|[^\d])(0?[1-9]|[12][0-9]|3[01])[\/\-\.](0?[1-9]|1[0-2])[\/\-\.]((?:20)?\d{2})(?=[^\d]|$)/g, type: 'standard' },
      // Format: YYYY/MM/DD
      { regex: /(?:^|[^\d])((?:20)\d{2})[\/\-\.](0?[1-9]|1[0-2])[\/\-\.](0?[1-9]|[12][0-9]|3[01])(?=[^\d]|$)/g, type: 'reverse' },
      // Format: Oct 27, 2026
      { regex: /(?:^|[^\d])(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s\.\-]+(0?[1-9]|[12][0-9]|3[01])(?:st|nd|rd|th)?,?[\s\.\-]+((?:20)?\d{2})(?=[^\d]|$)/gi, type: 'text_us' },
      // Format: 27 Oct 2026
      { regex: /(?:^|[^\d])(0?[1-9]|[12][0-9]|3[01])(?:st|nd|rd|th)?[\s\.\-]+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*,?[\s\.\-]+((?:20)?\d{2})(?=[^\d]|$)/gi, type: 'text_eu' }
    ];

    let day = "", month = "", year = "";
    const pad = (n: string) => n.padStart(2, '0');
    const fixYear = (y: string) => y.length === 2 ? `20${y}` : y;

    for (const {regex, type} of dateRegexes) {
      regex.lastIndex = 0;
      const match = regex.exec(text);
      if (match) {
        if (type === 'standard') {
          let p1 = parseInt(match[1], 10);
          let p2 = parseInt(match[2], 10);
          if (p1 > 12) {
            day = pad(match[1]); month = pad(match[2]);
          } else if (p2 > 12) {
            month = pad(match[1]); day = pad(match[2]);
          } else {
            // Default to DD-MM-YYYY
            day = pad(match[1]); month = pad(match[2]);
          }
          year = fixYear(match[3]);
        } else if (type === 'reverse') {
          year = fixYear(match[1]);
          month = pad(match[2]);
          day = pad(match[3]);
        } else if (type === 'text_us') {
          const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
          month = pad(String(months.findIndex(m => match[1].toLowerCase().startsWith(m)) + 1));
          day = pad(match[2]);
          year = fixYear(match[3]);
        } else if (type === 'text_eu') {
          const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
          day = pad(match[1]);
          month = pad(String(months.findIndex(m => match[2].toLowerCase().startsWith(m)) + 1));
          year = fixYear(match[3]);
        }
        break;
      }
    }

    let dateStr = "";
    if (day && month && year) {
      dateStr = `${year}-${month}-${day}`;
    } else {
      const today = new Date();
      dateStr = `${today.getFullYear()}-${pad(String(today.getMonth()+1))}-${pad(String(today.getDate()))}`;
    }

    return { storeName, dateStr };
  } catch (err) {
    console.error("OCR Error:", err);
    const today = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return { 
      storeName: "Receipt", 
      dateStr: `${today.getFullYear()}-${pad(today.getMonth()+1)}-${pad(today.getDate())}` 
    };
  }
};

const CameraView = ({ onCapture }: { onCapture: (file: File) => void }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoomSupported, setZoomSupported] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [maxZoom, setMaxZoom] = useState(1);

  useEffect(() => {
    let activeStream: MediaStream | null = null;
    const startCamera = async () => {
      try {
        const mediaStream = await navigator.mediaDevices.getUserMedia({
          video: { 
            facingMode: 'environment',
            width: { ideal: 2160 },
            height: { ideal: 3840 }
          }
        });
        activeStream = mediaStream;
        setStream(mediaStream);
        if (videoRef.current) {
          videoRef.current.srcObject = mediaStream;
          videoRef.current.onloadedmetadata = () => {
            const track = mediaStream.getVideoTracks()[0];
            if (track.getCapabilities) {
              const capabilities = track.getCapabilities() as any;
              if (capabilities.zoom) {
                setZoomSupported(true);
                setMaxZoom(capabilities.zoom.max || 1);
                const settings = track.getSettings() as any;
                if (settings.zoom) setZoomLevel(settings.zoom);
              }
            }
          };
        }
      } catch (err) {
        console.error("Error accessing camera", err);
        setError("Could not access camera. Please use the upload button below.");
      }
    };
    startCamera();
    return () => {
      if (activeStream) {
        activeStream.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  const handleZoom = async (level: number) => {
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    try {
      await track.applyConstraints({ advanced: [{ zoom: level } as any] });
      setZoomLevel(level);
    } catch (e) {
      console.error("Zoom failed", e);
    }
  };

  const capture = () => {
    if (videoRef.current && stream) {
      const canvas = document.createElement('canvas');
      canvas.width = videoRef.current.videoWidth;
      canvas.height = videoRef.current.videoHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(videoRef.current, 0, 0);
        canvas.toBlob((blob) => {
          if (blob) {
            const file = new File([blob], "capture.jpg", { type: "image/jpeg" });
            onCapture(file);
          }
        }, 'image/jpeg', 1.0); // Capture at full quality, compress later
      }
    }
  };

  if (error) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center p-6 text-center bg-neutral-800">
        <Camera className="w-12 h-12 text-neutral-600 mb-4" />
        <p className="text-neutral-400">{error}</p>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full bg-black">
      <video ref={videoRef} autoPlay playsInline className="w-full h-full object-cover" />
      
      {/* Viewfinder guides */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-1/4 left-8 right-8 bottom-1/4 border-2 border-white/30 rounded-xl">
           <div className="absolute top-0 left-0 w-8 h-8 border-t-4 border-l-4 border-white rounded-tl-xl -mt-1 -ml-1"></div>
           <div className="absolute top-0 right-0 w-8 h-8 border-t-4 border-r-4 border-white rounded-tr-xl -mt-1 -mr-1"></div>
           <div className="absolute bottom-0 left-0 w-8 h-8 border-b-4 border-l-4 border-white rounded-bl-xl -mb-1 -ml-1"></div>
           <div className="absolute bottom-0 right-0 w-8 h-8 border-b-4 border-r-4 border-white rounded-br-xl -mb-1 -mr-1"></div>
        </div>
      </div>

      {zoomSupported && maxZoom > 1 && (
        <div className="absolute bottom-32 left-0 right-0 flex justify-center gap-3">
          {[1, 2, 3, 5].filter(z => z <= maxZoom).map(z => (
            <button
              key={z}
              onClick={() => handleZoom(z)}
              className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold backdrop-blur-md transition-colors ${
                zoomLevel === z ? 'bg-blue-500 text-white' : 'bg-black/50 text-white border border-white/30'
              }`}
            >
              {z}x
            </button>
          ))}
        </div>
      )}

      <div className="absolute bottom-8 left-0 right-0 flex justify-center">
        <button 
          onClick={capture} 
          className="w-20 h-20 bg-white/20 rounded-full flex items-center justify-center backdrop-blur-sm active:scale-95 transition-transform"
        >
          <div className="w-16 h-16 bg-white rounded-full shadow-lg"></div>
        </button>
      </div>
    </div>
  );
};

export default function App() {
  const [view, setView] = useState<'camera' | 'preview'>('camera');
  const [originalFile, setOriginalFile] = useState<File | null>(null);
  const [compressedBlob, setCompressedBlob] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  
  const [companyInput, setCompanyInput] = useState('');
  const [ocrDate, setOcrDate] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const { companies, addCompany, sortMode, setSortMode, syncPin, updatePin, isSyncing } = useCompanies();

  const [isProcessing, setIsProcessing] = useState(false);
  const [progressText, setProgressText] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const cleanCompanyName = companyInput.replace(/[^a-zA-Z0-9\-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '') || 'Receipt';
  
  // Convert YYYY-MM-DD back to DD MM YYYY for the filename
  let displayDate = ocrDate;
  if (ocrDate && ocrDate.includes('-')) {
    const parts = ocrDate.split('-');
    if (parts.length === 3) {
      displayDate = `${parts[2]} ${parts[1]} ${parts[0]}`;
    }
  }
  
  const computedFilename = `${cleanCompanyName}-${displayDate}.jpg`;

  const handleCapture = async (file: File) => {
    setOriginalFile(file);
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    setView('preview');
    setIsProcessing(true);
    setProgressText('Compressing image...');
    setError(null);

    try {
      const compressed = await compressImage(file);
      setCompressedBlob(compressed);
      
      setProgressText('Enhancing image for OCR...');
      const ocrReadyBlob = await preprocessImageForOCR(compressed);
      
      const { storeName, dateStr } = await getFilenameFromTesseract(ocrReadyBlob, setProgressText);
      setCompanyInput(storeName);
      setOcrDate(dateStr);
    } catch (err) {
      console.error(err);
      setError("Failed to process image. Please try again.");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDownload = () => {
    if (!compressedBlob || !computedFilename) return;
    
    if (companyInput) {
      addCompany(companyInput);
    }

    const url = URL.createObjectURL(compressedBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = computedFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const reset = () => {
    setView('camera');
    setOriginalFile(null);
    setCompressedBlob(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setCompanyInput('');
    setOcrDate('');
    setError(null);
  };

  return (
    <div className="min-h-screen bg-neutral-900 text-white flex flex-col items-center justify-center p-4 font-sans">
      <div className="w-full max-w-md flex flex-col gap-6">
        
        <div className="text-center space-y-2 relative">
          <h1 className="text-3xl font-semibold tracking-tight text-neutral-100">Receipt Scanner</h1>
          <p className="text-neutral-400 text-sm">Snap a receipt to auto-name and compress it.</p>
          <button 
            onClick={() => setShowSettings(true)}
            className="absolute top-0 right-0 p-2 text-neutral-400 hover:text-white transition-colors"
            title="Sync Settings"
          >
            {syncPin && syncPin.length === 6 ? (
              <Cloud className="w-5 h-5 text-blue-400" />
            ) : (
              <CloudOff className="w-5 h-5" />
            )}
            {isSyncing && (
              <span className="absolute top-1 right-1 w-2 h-2 bg-blue-500 rounded-full animate-ping"></span>
            )}
          </button>
        </div>

        {/* Settings Modal */}
        {showSettings && (
          <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-6">
            <div className="bg-neutral-900 border border-white/10 p-6 rounded-2xl w-full max-w-xs shadow-2xl">
              <h3 className="text-lg font-semibold text-white mb-2 flex items-center gap-2">
                <Cloud className="w-5 h-5 text-blue-400" />
                Cloud Sync
              </h3>
              <p className="text-sm text-neutral-400 mb-6">Enter a 6-digit PIN to sync your saved companies across devices.</p>
              
              <input 
                type="text" 
                maxLength={6}
                value={syncPin}
                onChange={e => updatePin(e.target.value.replace(/\D/g, ''))}
                placeholder="000000"
                className="w-full bg-black/50 border border-white/10 rounded-xl px-4 py-3 text-center text-2xl tracking-[0.5em] text-white focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all font-mono mb-6"
              />
              
              <div className="flex gap-3">
                <button 
                  onClick={() => setShowSettings(false)}
                  className="flex-1 py-3 bg-white/10 hover:bg-white/20 text-white rounded-xl font-medium transition-colors"
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="bg-neutral-800 rounded-3xl overflow-hidden shadow-2xl ring-1 ring-white/10 aspect-[1/2.5] max-h-[70vh] w-full max-w-[280px] mx-auto relative">
          {view === 'camera' ? (
            <CameraView onCapture={handleCapture} />
          ) : (
            <div className="w-full h-full relative flex flex-col">
              {previewUrl && (
                <img src={previewUrl} alt="Preview" className="w-full h-full object-cover opacity-50" />
              )}
              
              <div className="absolute inset-0 flex flex-col items-center p-5 bg-black/60 backdrop-blur-md overflow-y-auto">
                {isProcessing ? (
                  <div className="flex flex-col items-center justify-center h-full gap-4 my-auto">
                    <Loader2 className="w-12 h-12 text-blue-400 animate-spin" />
                    <p className="text-blue-200 font-medium animate-pulse">{progressText}</p>
                  </div>
                ) : error ? (
                  <div className="flex flex-col items-center justify-center h-full gap-4 text-center my-auto">
                    <div className="w-16 h-16 bg-red-500/20 rounded-full flex items-center justify-center">
                      <RefreshCw className="w-8 h-8 text-red-400" />
                    </div>
                    <p className="text-red-300">{error}</p>
                    <button onClick={reset} className="mt-4 px-6 py-2 bg-white/10 hover:bg-white/20 rounded-full transition-colors">
                      Try Again
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-4 w-full max-w-xs my-auto py-4">
                    {previewUrl && (
                      <div className="w-20 h-28 shrink-0 rounded-xl overflow-hidden border border-white/20 shadow-xl mb-2 relative">
                        <img src={previewUrl} alt="Preview" className="w-full h-full object-cover" />
                        <div className="absolute inset-0 ring-1 ring-inset ring-black/20 rounded-xl"></div>
                      </div>
                    )}
                    
                    <div className="relative w-full text-left">
                      <label className="text-xs text-neutral-400 uppercase tracking-wider font-semibold mb-1 block">Company Name</label>
                      <div className="relative">
                        <input 
                          type="text" 
                          value={companyInput}
                          onChange={e => setCompanyInput(e.target.value)}
                          onFocus={() => setShowDropdown(true)}
                          onBlur={() => setTimeout(() => setShowDropdown(false), 200)}
                          className="w-full bg-black/50 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"
                          placeholder="Enter company name..."
                        />
                        {showDropdown && companies.length > 0 && (
                          <div className="absolute top-full left-0 right-0 mt-2 bg-neutral-800 border border-white/10 rounded-xl shadow-2xl z-50 overflow-hidden flex flex-col max-h-48">
                             <div className="flex items-center justify-between px-3 py-2 border-b border-white/10 bg-neutral-900/50">
                               <span className="text-[10px] text-neutral-400 uppercase font-bold tracking-wider">Saved Companies</span>
                               <div className="flex gap-1">
                                 <button onMouseDown={(e) => { e.preventDefault(); setSortMode('recent'); }} className={`p-1.5 rounded-md transition-colors ${sortMode === 'recent' ? 'bg-blue-500/20 text-blue-400' : 'text-neutral-500 hover:text-neutral-300 hover:bg-white/5'}`} title="Most Recent"><Clock className="w-3 h-3" /></button>
                                 <button onMouseDown={(e) => { e.preventDefault(); setSortMode('frequent'); }} className={`p-1.5 rounded-md transition-colors ${sortMode === 'frequent' ? 'bg-blue-500/20 text-blue-400' : 'text-neutral-500 hover:text-neutral-300 hover:bg-white/5'}`} title="Most Frequent"><TrendingUp className="w-3 h-3" /></button>
                                 <button onMouseDown={(e) => { e.preventDefault(); setSortMode('alphabetical'); }} className={`p-1.5 rounded-md transition-colors ${sortMode === 'alphabetical' ? 'bg-blue-500/20 text-blue-400' : 'text-neutral-500 hover:text-neutral-300 hover:bg-white/5'}`} title="Alphabetical"><ArrowDownAZ className="w-3 h-3" /></button>
                               </div>
                             </div>
                             <div className="overflow-y-auto">
                               {companies.map(c => (
                                 <button 
                                   key={c.name}
                                   onMouseDown={(e) => {
                                     e.preventDefault();
                                     setCompanyInput(c.name);
                                     setShowDropdown(false);
                                   }}
                                   className="w-full text-left px-4 py-2.5 hover:bg-white/5 text-sm text-neutral-200 focus:outline-none transition-colors border-b border-white/5 last:border-0"
                                 >
                                   {c.name}
                                 </button>
                               ))}
                             </div>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="relative w-full text-left">
                      <label className="text-xs text-neutral-400 uppercase tracking-wider font-semibold mb-1 block">Receipt Date</label>
                      <DatePicker
                        selected={ocrDate ? parse(ocrDate, 'yyyy-MM-dd', new Date()) : null}
                        onChange={(date: Date | null) => {
                          if (date && isValid(date)) {
                            setOcrDate(format(date, 'yyyy-MM-dd'));
                          } else {
                            setOcrDate('');
                          }
                        }}
                        dateFormat="dd MM yyyy"
                        className="w-full bg-black/50 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"
                        placeholderText="DD MM YYYY"
                        wrapperClassName="w-full"
                      />
                    </div>

                    <div className="w-full bg-black/50 p-4 rounded-xl border border-white/10 space-y-1 text-left">
                      <p className="text-xs text-neutral-400 uppercase tracking-wider font-semibold">Final Filename</p>
                      <p className="text-sm font-mono text-green-300 break-all">{computedFilename}</p>
                    </div>

                    <div className="w-full bg-black/50 p-4 rounded-xl border border-white/10 flex justify-between items-center">
                       <div className="space-y-1 text-left">
                         <p className="text-xs text-neutral-400 uppercase tracking-wider font-semibold">Original Size</p>
                         <p className="text-sm text-neutral-200">{originalFile ? (originalFile.size / 1024).toFixed(1) : 0} KB</p>
                       </div>
                       <div className="space-y-1 text-right">
                         <p className="text-xs text-neutral-400 uppercase tracking-wider font-semibold">Optimized Size</p>
                         <p className="text-sm text-blue-300">{compressedBlob ? (compressedBlob.size / 1024).toFixed(1) : 0} KB</p>
                       </div>
                    </div>

                    <button 
                      onClick={handleDownload}
                      className="w-full py-4 bg-blue-600 hover:bg-blue-500 text-white rounded-2xl font-semibold flex items-center justify-center gap-2 transition-colors shadow-lg shadow-blue-900/20 cursor-pointer mt-2 shrink-0"
                    >
                      <Download className="w-5 h-5" />
                      Save Receipt
                    </button>
                    
                    <button 
                      onClick={reset}
                      className="text-neutral-400 hover:text-white text-sm transition-colors py-3 px-6 cursor-pointer mt-2 bg-white/5 hover:bg-white/10 rounded-full shrink-0"
                    >
                      Scan Another
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {view === 'camera' && (
          <div className="flex justify-center">
             <input 
                type="file" 
                accept="image/*" 
                capture="environment"
                className="hidden" 
                ref={fileInputRef}
                onChange={(e) => {
                  if (e.target.files && e.target.files[0]) {
                    handleCapture(e.target.files[0]);
                  }
                }}
              />
            <button 
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2 px-6 py-3 bg-neutral-800 hover:bg-neutral-700 rounded-full text-neutral-300 transition-colors border border-neutral-700 cursor-pointer"
            >
              <ImageIcon className="w-5 h-5" />
              <span>Upload from Gallery</span>
            </button>
          </div>
        )}

      </div>
    </div>
  );
}
