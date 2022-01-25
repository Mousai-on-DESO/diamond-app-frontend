// @ts-strict
import { AfterViewInit, ChangeDetectorRef, Component, EventEmitter, Input, Output } from "@angular/core";
import { ActivatedRoute, Router } from "@angular/router";
import { GlobalVarsService } from "../../global-vars.service";
import { BackendApiService, PostEntryResponse } from "../../backend-api.service";
import { Datasource } from "ngx-ui-scroll";
import { ToastrService } from "ngx-toastr";
import { Title } from "@angular/platform-browser";
import { Location } from "@angular/common";
import { environment } from "src/environments/environment";
import { Thread, ThreadManager } from "../helpers/thread-manager";

import * as _ from "lodash";
import { document } from "ngx-bootstrap/utils";
import { Subscription } from "rxjs";

@Component({
  selector: "post-thread",
  templateUrl: "./post-thread.component.html",
  styleUrls: ["./post-thread.component.scss"],
})
export class PostThreadComponent implements AfterViewInit {
  currentPost: PostEntryResponse | undefined;
  postHashHexRouteParam: string | undefined;
  previousPostHashHex: string | undefined;
  scrollingDisabled = false;
  showToast = false;
  subscriptions = new Subscription();
  threadManager: ThreadManager | undefined;
  datasource = new Datasource<Thread>({
    get: (index, count, success) => {
      const numThreads = this.threadManager?.threadCount ?? 0;
      if (this.scrollingDisabled && index > numThreads) {
        success([]);
      } else if (numThreads > index + count) {
        // MinIndex doesn't actually prevent us from going below 0, causing initial posts to disappear on long thread
        const start = index < 0 ? 0 : index;
        success(this.threadManager?.threads.slice(start, index + count) ?? []);
      } else {
        this.getPost(false, index, count)?.subscribe(
          (res) => {
            // If we got more comments, push them onto the list of comments, increase comment count
            // and determine if we should continue scrolling
            if (res.PostFound.Comments?.length) {
              if (res.PostFound.Comments.length < count) {
                this.scrollingDisabled = true;
              }
              this.threadManager?.addThreads(res.PostFound.Comments);
              success(this.threadManager?.threads.slice(index, index + count) ?? []);
            } else {
              // If there are no more comments, we should stop scrolling
              this.scrollingDisabled = true;
              success([]);
            }
          },
          (err) => {
            // TODO: post threads: rollbar
            console.error(err);
            this.router.navigateByUrl("/" + this.globalVars.RouteNames.NOT_FOUND, { skipLocationChange: true });
          }
        );
      }
    },
    settings: {
      startIndex: 0,
      minIndex: 0,
      bufferSize: 10,
      windowViewport: true,
      infinite: true,
    },
  });

  @Input() hideHeader: boolean = false;
  @Input() hideCurrentPost: boolean = false;
  @Output() postLoaded = new EventEmitter();

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    public globalVars: GlobalVarsService,
    private backendApi: BackendApiService,
    private toastr: ToastrService,
    private titleService: Title,
    private location: Location
  ) {
    // This line forces the component to reload when only a url param changes.  Without this, the UiScroll component
    // behaves strangely and can reuse data from a previous post.
    this.router.routeReuseStrategy.shouldReuseRoute = () => false;
    this.route.params.subscribe((params) => {
      // executed on initial load and every time the PostHashHex url param is
      // updated.
      this._setStateFromActivatedRoute(route);
    });
  }

  ngAfterViewInit() {
    this.subscriptions.add(
      this.datasource.adapter?.lastVisible$.subscribe((lastVisible) => {
        setTimeout(() => {
          if (lastVisible.element?.parentElement) {
            this.correctDataPaddingForwardElementHeight(lastVisible.element.parentElement);
          }
        }, 1);
      })
    );
  }

  // Thanks to @brabenetz for the solution on forward padding with the ngx-ui-scroll component.
  // https://github.com/dhilt/ngx-ui-scroll/issues/111#issuecomment-697269318
  correctDataPaddingForwardElementHeight(viewportElement: HTMLElement): void {
    const dataPaddingForwardElement = viewportElement.querySelector(`[data-padding-forward]`);
    if (dataPaddingForwardElement) {
      dataPaddingForwardElement.setAttribute("style", "height: 0px;");
    }
  }

  /**
   * When adding a reply to a subcomment, we need to know if it already has a
   * reply rendered in the UI. If it does, we just increment the comment count.
   * If it doesn't currently have a reply in the UI we increment the parent
   * comment count AND render the new reply.
   */
  async appendToSubcommentList(
    replyParent: PostEntryResponse,
    threadParent: PostEntryResponse,
    newPost: PostEntryResponse
  ) {
    const thread = this.threadManager?.getThread(threadParent.PostHashHex);

    if (!thread) {
      // NOTE: This should *never* happen unless there is a bug. It's totally
      // unexpected in any case. Likely we should show a ui error.
      console.error(`No thread found for PostHashHex ${threadParent.PostHashHex}`);
      return;
    }

    await this.datasource.adapter.relax(); // Wait until it's ok to modify the data
    await this.datasource.adapter.replace({
      predicate: (item) => {
        const dataSourceItem = item as any;
        const post = dataSourceItem.data.parent;
        if (post.PostHashHex === threadParent.PostHashHex) {
          const beforeReplyCount = thread.children.length;
          this.threadManager?.addReplyToComment(thread, replyParent, newPost);
          const afterReplyCount = thread.children.length;

          if (beforeReplyCount === afterReplyCount) {
            // if we hit this case, it means only the count was incremented for an intermediate
            // reply. The new reply was not actually rendered in the UI.
            this.toastr.info("Your post was sent!", undefined, { positionClass: "toast-top-center", timeOut: 3000 });
          }
          return true;
        }

        return false;
      },
      items: [thread],
    });
  }

  /**
   * Called if a users replies to a parent post of the current post in the page
   * header.
   */
  updateParentCommentCountAndShowToast(parentPost: PostEntryResponse) {
    parentPost.CommentCount += 1;

    // Show toast when adding comment to parent post
    this.toastr.info("Your post was sent!", undefined, { positionClass: "toast-top-center", timeOut: 3000 });
  }

  /**
   * This prepends a new top level comment thread to the current post. Note this is transitory
   * and only for UX convenience. If the comments are reloaded from the api it will appear in
   * its true chronological position.
   */
  async prependToCommentList(postEntryResponse: PostEntryResponse) {
    this.threadManager?.prependComment(postEntryResponse);

    const thread = this.threadManager?.getThread(postEntryResponse.PostHashHex);

    if (!thread) {
      // NOTE: This should *never* happen unless there is a bug. It's totally
      // unexpected in any case. Likely we should throw an error and show a ui
      // error.
      console.error(`No thread found for PostHashHex ${postEntryResponse.PostHashHex}`);
      return;
    }

    await this.datasource.adapter.relax();
    await this.datasource.adapter.prepend(thread);
  }

  /**
   * If the main post for the the page is hidden, we just bail and go back to
   * home feed. TODO: this has a bug. Posts cached in the global state can still
   * show up in the user's the global feed after deletion. Maybe we can fix this
   * by optimizing the fetch for the feed to be faster and not need client side
   * caching for the feed.
   */
  onCurrentPostHidden() {
    this.router.navigate(["/"], { queryParamsHandling: "merge" });
  }

  /**
   * When a subcomment is hidden we just need to decrement its parent's comment
   * count. The feed component will internally adjust its UI to hide the
   * content.
   */
  async onSubcommentHidden(commentToHide: PostEntryResponse, parentComment: PostEntryResponse, thread: Thread) {
    await this.datasource.adapter.relax();
    await this.datasource.adapter.replace({
      predicate: (item) => {
        const dataSourceItem = item as any;
        if (dataSourceItem.data.parent.PostHashHex === thread.parent.PostHashHex) {
          this.threadManager?.hideComment(thread, commentToHide, parentComment);
          return true;
        }

        return false;
      },
      items: [thread],
    });
  }

  getPost(
    fetchParents = true,
    commentOffset = 0,
    commentLimit = 20,
    subCommentPostHashHex: string | undefined = undefined
  ) {
    // Hit the Get Single Post endpoint with specific parameters
    let readerPubKey = "";
    if (this.globalVars.loggedInUser) {
      readerPubKey = this.globalVars.loggedInUser.PublicKeyBase58Check;
    }

    if (!this.postHashHexRouteParam) {
      console.error("This means the router has an error. This is fubar if we make it here.");
      return;
    }

    return this.backendApi.GetSinglePost(
      this.globalVars.localNode,
      subCommentPostHashHex ?? this.postHashHexRouteParam /*PostHashHex*/,
      readerPubKey /*ReaderPublicKeyBase58Check*/,
      fetchParents,
      commentOffset,
      commentLimit,
      this.globalVars.showAdminTools() /*AddGlobalFeedBool*/
    );
  }

  refreshPosts() {
    // Fetch the post entry
    this.getPost()?.subscribe(
      (res) => {
        if (!res || !res.PostFound) {
          this.router.navigateByUrl("/" + this.globalVars.RouteNames.NOT_FOUND, { skipLocationChange: true });
          return;
        }
        if (
          res.PostFound.IsNFT &&
          (!this.route.snapshot.url.length || this.route.snapshot.url[0].path != this.globalVars.RouteNames.NFT)
        ) {
          this.router.navigate(["/" + this.globalVars.RouteNames.NFT, this.postHashHexRouteParam], {
            queryParamsHandling: "merge",
          });
          return;
        }
        // Set current post
        this.currentPost = res.PostFound as PostEntryResponse;
        this.threadManager = new ThreadManager(res.PostFound);
        const postType = this.currentPost.RepostedPostEntryResponse ? "Repost" : "Post";
        this.postLoaded.emit(
          `${this.globalVars.addOwnershipApostrophe(this.currentPost.ProfileEntryResponse.Username)} ${postType}`
        );
        this.titleService.setTitle(this.currentPost.ProfileEntryResponse.Username + ` on ${environment.node.name}`);
      },
      (err) => {
        // TODO: post threads: rollbar
        console.error(err);
        this.router.navigateByUrl("/" + this.globalVars.RouteNames.NOT_FOUND, { skipLocationChange: true });
      }
    );
  }

  _setStateFromActivatedRoute(route: ActivatedRoute) {
    // get the username of the target user (user whose followers / following we're obtaining)
    this.postHashHexRouteParam = route.snapshot.params.postHashHex;

    // it's important that we call this here and not in ngOnInit. Angular does not reload components when only a param changes.
    // We are responsible for refreshing the components.
    // if the user is on a thread page and clicks on a comment, the currentPostHashHex will change, but angular won't "load a new
    // page" and re-render the whole component using the new post hash. instead, angular will
    // continue using the current component and merely change the URL. so we need to explictly
    // refresh the posts every time the route changes.
    if (this.threadManager) {
      this.threadManager.reset();
    }

    this.refreshPosts();
    this.datasource.adapter.reset();
  }

  isPostBlocked(post: any): boolean {
    return this.globalVars.hasUserBlockedCreator(post.PosterPublicKeyBase58Check);
  }

  afterUserBlocked(blockedPubKey: any) {
    this.globalVars.loggedInUser.BlockedPubKeys[blockedPubKey] = {};
  }

  loadMoreReplies(thread: Thread, subcomment: PostEntryResponse) {
    this.getPost(false, 0, 1, subcomment.PostHashHex)?.subscribe(
      (res) => {
        if (!res || !res.PostFound) {
          throw "This should never happen unless there is an api error. Let's show a toast just in case?";
        }
        this.threadManager?.addChildrenToThread(thread, res.PostFound);
      },
      (err) => {
        // TODO: show a toast
        console.error(err);
      }
    );
  }
}
