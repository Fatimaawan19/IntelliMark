import React, { useRef, useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { 
  ChevronLeft, 
  MessageSquare,
  Search,
  Filter,
  CheckCircle,
  Clock,
  AlertCircle,
  Send,
  X
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { db, auth } from '../../firebase';
import { collection, doc, updateDoc, addDoc, serverTimestamp, onSnapshot } from 'firebase/firestore';
import { onAuthStateChanged } from 'firebase/auth';
import { useToast } from '@/hooks/use-toast';

const STUDENT_TEACHER_QUERY_COLLECTION = 'student_teacher_querey';

interface StudentQuery {
  id: string;
  studentId: string;
  studentName: string;
  studentEmail: string;
  studentDegree: string;
  courseName: string;
  courseId: string;
  assessmentTitle: string;
  assessmentId: string;
  subject?: string;
  query: string;
  type: 'recheck' | 'feedback' | 'error' | 'clarification';
  status: 'pending' | 'resolved';
  createdAt: any;
  reply?: string;
  repliedAt?: any;
}

const TeacherQueries: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  const [currentUser, setCurrentUser] = useState<any>(null);
  const [queries, setQueries] = useState<StudentQuery[]>([]);
  const [filteredQueries, setFilteredQueries] = useState<StudentQuery[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'pending' | 'resolved'>('all');
  const [filterType, setFilterType] = useState<'all' | 'recheck' | 'feedback' | 'error' | 'clarification'>('all');
  const [loading, setLoading] = useState(true);
  const [selectedQuery, setSelectedQuery] = useState<StudentQuery | null>(null);
  const [showReplyDialog, setShowReplyDialog] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [isReplying, setIsReplying] = useState(false);

  const openedFromDashboardRef = useRef<string>("");

  // Monitor auth state
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      if (!user) {
        setQueries([]);
        setFilteredQueries([]);
        setLoading(false);
      }
    });

    return () => unsubscribe();
  }, []);

  // Real-time queries for this teacher (routed by assessment teacherId)
  useEffect(() => {
    const teacherId = currentUser?.uid;
    if (!teacherId) return;

    setLoading(true);
    const queriesRef = collection(db, STUDENT_TEACHER_QUERY_COLLECTION);
    const unsubscribe = onSnapshot(
      queriesRef,
      (snapshot) => {
        const queriesData: StudentQuery[] = [];

        for (const queryDoc of snapshot.docs) {
          const queryData = queryDoc.data();
          if (String(queryData.teacherId || '') !== teacherId) continue;

          queriesData.push({
            id: queryDoc.id,
            studentId: queryData.studentId || '',
            studentName: queryData.studentName || 'Unknown',
            studentEmail: queryData.studentEmail || 'N/A',
            studentDegree: queryData.studentDegree || 'N/A',
            courseName: queryData.courseName || 'Unknown Course',
            courseId: queryData.courseId || '',
            assessmentTitle: queryData.assessmentTitle || queryData.assignmentTitle || '—',
            assessmentId: queryData.assessmentId || queryData.assignmentId || '',
            subject: queryData.subject || '',
            query: queryData.query || queryData.message || '',
            type: queryData.type || 'clarification',
            status: queryData.status || 'pending',
            createdAt: queryData.createdAt,
            reply: queryData.reply,
            repliedAt: queryData.repliedAt
          });
        }

        queriesData.sort((a, b) => {
          const ta = a.createdAt?.toDate ? a.createdAt.toDate().getTime() : 0;
          const tb = b.createdAt?.toDate ? b.createdAt.toDate().getTime() : 0;
          return tb - ta;
        });

        setQueries(queriesData);
        setLoading(false);
      },
      (err) => {
        console.error('Error listening to student_teacher_querey:', err);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [currentUser?.uid]);

  // If navigated from TeacherDashboard, auto-open the selected query.
  useEffect(() => {
    const openQueryId = (location as any)?.state?.openQueryId;
    const id = String(openQueryId || "").trim();
    if (!id) return;
    if (loading) return;
    if (openedFromDashboardRef.current === id) return;

    const found = queries.find((q) => q.id === id);
    if (!found) return;

    openedFromDashboardRef.current = id;
    handleReplyClick(found);
  }, [location, loading, queries]);

  // Filter queries based on search and filters
  useEffect(() => {
    let filtered = queries;

    // Search filter
    if (searchTerm.trim()) {
      filtered = filtered.filter(q =>
        q.studentName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        q.courseName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        q.assessmentTitle.toLowerCase().includes(searchTerm.toLowerCase()) ||
        q.query.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }

    // Status filter
    if (filterStatus !== 'all') {
      filtered = filtered.filter(q => q.status === filterStatus);
    }

    // Type filter
    if (filterType !== 'all') {
      filtered = filtered.filter(q => q.type === filterType);
    }

    setFilteredQueries(filtered);
  }, [searchTerm, filterStatus, filterType, queries]);

  const handleReplyClick = (query: StudentQuery) => {
    setSelectedQuery(query);
    setReplyText(query.reply || '');
    setShowReplyDialog(true);
  };

  const handleSendReply = async () => {
    if (!selectedQuery || !replyText.trim()) return;

    setIsReplying(true);
    try {
      const wasPending = selectedQuery.status === 'pending';
      const queryRef = doc(db, STUDENT_TEACHER_QUERY_COLLECTION, selectedQuery.id);
      await updateDoc(queryRef, {
        reply: replyText,
        repliedAt: serverTimestamp(),
        status: 'resolved'
      });

      const studentId = String(selectedQuery.studentId || '').trim();
      if (studentId) {
        try {
          const teacherName =
            currentUser?.displayName ||
            currentUser?.email ||
            'Your teacher';
          const msgPreview =
            replyText.trim().length > 220
              ? `${replyText.trim().slice(0, 220)}…`
              : replyText.trim();
          await addDoc(collection(db, 'notifications'), {
            type: 'success',
            actionType: 'query_reply',
            recipientId: studentId,
            recipientRole: 'student',
            title: wasPending
              ? 'Your teacher responded'
              : 'Your teacher updated their reply',
            message: `Re: ${selectedQuery.assessmentTitle} — ${msgPreview}`,
            queryId: selectedQuery.id,
            assessmentId: selectedQuery.assessmentId,
            assessmentTitle: selectedQuery.assessmentTitle,
            courseId: selectedQuery.courseId,
            courseName: selectedQuery.courseName,
            createdById: currentUser?.uid || '',
            createdByName: teacherName,
            read: false,
            createdAt: serverTimestamp(),
          });
        } catch (notifErr) {
          console.warn('Reply saved but student notification failed:', notifErr);
        }
      }

      toast({
        title: 'Message sent!',
      });

      setShowReplyDialog(false);
      setReplyText('');
      setSelectedQuery(null);
    } catch (error) {
      console.error('Error sending reply:', error);
      toast({
        title: 'Could not send',
        description: 'Something went wrong. Please try again.',
        variant: 'destructive',
      });
    } finally {
      setIsReplying(false);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'pending': return 'bg-yellow-100 text-yellow-700';
      case 'resolved': return 'bg-green-100 text-green-700';
      default: return 'bg-gray-100 text-gray-700';
    }
  };

  const getTypeColor = (type: string) => {
    switch (type) {
      case 'recheck': return 'bg-blue-100 text-blue-700';
      case 'feedback': return 'bg-purple-100 text-purple-700';
      case 'error': return 'bg-red-100 text-red-700';
      case 'clarification': return 'bg-orange-100 text-orange-700';
      default: return 'bg-gray-100 text-gray-700';
    }
  };

  const formatDate = (date: any) => {
    if (!date) return 'N/A';
    const dateObj = date.toDate ? date.toDate() : new Date(date);
    return dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-gray-50 to-slate-100">
      {/* Header */}
      <div className="px-4 md:px-6 pt-8 pb-6 bg-white/80 backdrop-blur-md shadow-sm border-b border-primary/10">
        <div className="max-w-7xl mx-auto">
          <div className="flex items-center gap-4 mb-6">
            <Button 
              variant="ghost" 
              onClick={() => navigate('/teacher-dashboard')}
              className="hover:bg-primary/10 transition-all p-2 rounded-lg"
            >
              <ChevronLeft className="h-5 w-5 text-gray-700" />
            </Button>
            <div>
              <h1 className="text-3xl font-bold bg-gradient-to-r from-primary to-primary/70 bg-clip-text text-transparent">
                Student Queries
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                View and reply to student queries
              </p>
            </div>
          </div>

          {/* Search and Filters */}
          <div className="flex flex-col md:flex-row gap-4">
            {/* Search Bar */}
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-3 h-5 w-5 text-gray-400" />
              <Input
                placeholder="Search by student name, course, or query..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10 border-primary/30 focus:border-primary"
              />
            </div>

            {/* Status Filter */}
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value as any)}
              className="px-4 py-2 rounded-lg border border-primary/30 focus:border-primary focus:outline-none text-sm font-medium bg-white"
            >
              <option value="all">All Status</option>
              <option value="pending">Pending</option>
              <option value="resolved">Resolved</option>
            </select>

            {/* Type Filter */}
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value as any)}
              className="px-4 py-2 rounded-lg border border-primary/30 focus:border-primary focus:outline-none text-sm font-medium bg-white"
            >
              <option value="all">All Types</option>
              <option value="clarification">Clarification</option>
              <option value="feedback">Feedback</option>
              <option value="recheck">Recheck</option>
              <option value="error">Error</option>
            </select>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mt-6">
            <div className="p-3 bg-primary/5 rounded-lg border border-primary/20">
              <p className="text-xs text-muted-foreground">Total Queries</p>
              <p className="text-2xl font-bold text-primary">{queries.length}</p>
            </div>
            <div className="p-3 bg-yellow-100/50 rounded-lg border border-yellow-200/50">
              <p className="text-xs text-muted-foreground">Pending</p>
              <p className="text-2xl font-bold text-yellow-600">{queries.filter(q => q.status === 'pending').length}</p>
            </div>
            <div className="p-3 bg-green-100/50 rounded-lg border border-green-200/50">
              <p className="text-xs text-muted-foreground">Resolved</p>
              <p className="text-2xl font-bold text-green-600">{queries.filter(q => q.status === 'resolved').length}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-7xl mx-auto px-4 md:px-6 py-8">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="text-center">
              <MessageSquare className="h-16 w-16 text-primary/20 mx-auto mb-4" />
              <p className="text-muted-foreground">Loading queries...</p>
            </div>
          </div>
        ) : filteredQueries.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <div className="text-center">
              <MessageSquare className="h-16 w-16 text-primary/20 mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-black mb-2">No Queries Found</h3>
              <p className="text-muted-foreground">
                {searchTerm || filterStatus !== 'all' || filterType !== 'all'
                  ? 'Try adjusting your search or filters'
                  : 'No student queries at the moment'}
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {filteredQueries.map((query) => (
              <Card key={query.id} className="border-primary/20 shadow-sm hover:shadow-md transition-all">
                <CardHeader className="pb-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-2">
                        <h3 className="font-bold text-lg text-black">{query.studentName}</h3>
                        <Badge variant="outline" className="text-xs">
                          {query.studentDegree}
                        </Badge>
                      </div>
                      <p className="text-sm text-muted-foreground">{query.studentEmail}</p>
                      <p className="text-sm text-gray-700 mt-2 font-medium">{query.courseName}</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Assessment: <span className="font-medium text-gray-800">{query.assessmentTitle}</span>
                        {query.assessmentId ? (
                          <span className="ml-2 font-mono text-[11px]">({query.assessmentId})</span>
                        ) : null}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <Badge className={getStatusColor(query.status)}>
                        {query.status === 'pending' ? (
                          <><Clock className="h-3 w-3 mr-1" /> Pending</>
                        ) : (
                          <><CheckCircle className="h-3 w-3 mr-1" /> Resolved</>
                        )}
                      </Badge>
                      <Badge className={getTypeColor(query.type)}>
                        {query.type.charAt(0).toUpperCase() + query.type.slice(1)}
                      </Badge>
                    </div>
                  </div>
                </CardHeader>

                <CardContent>
                  <div className="space-y-4">
                    {/* Query */}
                    <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
                      <p className="text-xs text-muted-foreground mb-2">Student Query</p>
                      <p className="text-sm text-black">{query.query}</p>
                      <p className="text-xs text-muted-foreground mt-2">
                        Asked on {formatDate(query.createdAt)}
                      </p>
                    </div>

                    {/* Reply */}
                    {query.reply ? (
                      <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
                        <p className="text-xs text-muted-foreground mb-2">Your Reply</p>
                        <p className="text-sm text-black">{query.reply}</p>
                        <p className="text-xs text-muted-foreground mt-2">
                          Replied on {formatDate(query.repliedAt)}
                        </p>
                      </div>
                    ) : null}

                    {/* Action Button */}
                    {query.status === 'pending' && (
                      <Button
                        onClick={() => handleReplyClick(query)}
                        className="w-full gap-2"
                      >
                        <Send className="h-4 w-4" />
                        Reply to Query
                      </Button>
                    )}
                    {query.status === 'resolved' && (
                      <Button
                        variant="outline"
                        onClick={() => handleReplyClick(query)}
                        className="w-full gap-2"
                      >
                        <MessageSquare className="h-4 w-4" />
                        Edit Reply
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Reply Dialog */}
      <Dialog open={showReplyDialog} onOpenChange={setShowReplyDialog}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Reply to {selectedQuery?.studentName}'s Query</DialogTitle>
            <DialogDescription>
              Course: {selectedQuery?.courseName}
              {selectedQuery?.assessmentTitle ? (
                <> · Assessment: {selectedQuery.assessmentTitle}</>
              ) : null}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {/* Original Query */}
            <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
              <p className="text-xs text-muted-foreground mb-2">Original Query</p>
              <p className="text-sm text-black">{selectedQuery?.query}</p>
            </div>

            {/* Reply Input */}
            <div>
              <label className="text-sm font-medium text-black mb-2 block">Your Reply</label>
              <Textarea
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                placeholder="Type your reply here..."
                className="min-h-32"
              />
            </div>
          </div>

          <div className="flex gap-3 justify-end">
            <Button
              variant="outline"
              onClick={() => setShowReplyDialog(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSendReply}
              disabled={!replyText.trim() || isReplying}
              className="gap-2"
            >
              <Send className="h-4 w-4" />
              {isReplying ? 'Sending...' : 'Send Reply'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default TeacherQueries;
