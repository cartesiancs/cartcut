const CARTCUT_WEBSITE = "https://nugget.studio";
let APP_;

let toastElList = [].slice.call(document.querySelectorAll(".toast"));
let toastList = toastElList.map(function (toastEl) {
  return new bootstrap.Toast(toastEl);
});

const elementControlComponent = document.querySelector("element-control");
let preview = document.getElementById("preview");
let control = document.getElementById("control-inner");
let video = document.getElementById("video");
// let exportVideoModal = new bootstrap.Modal(
//   document.getElementById("exportVideoModal"),
//   {
//     keyboard: false,
//   }
// );

class ModalClass {
  id: any;
  action: any;
  constructor(id) {
    try {
      this.id = id;
      this.action = new bootstrap.Modal(document.getElementById(id), {
        keyboard: false,
      });
    } catch (error) {}
  }

  show() {
    try {
      this.action.show();
    } catch (error) {
      this.action = new bootstrap.Modal(document.getElementById(this.id), {
        keyboard: false,
      });
      this.action.show();
    }
  }

  hide() {
    this.action.hide();
  }
}

export const rendererModal = {
  progressModal: new ModalClass("progressRender"),
  progressFinish: new ModalClass("progressFinish"),
  progressError: new ModalClass("progressError"),
  whenClose: new ModalClass("whenClose"),
  whenTimelineChanged: new ModalClass("whenTimelineChanged"),
};
